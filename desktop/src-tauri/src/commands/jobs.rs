use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::claude_session::ProcessProvider;
use crate::config::jobs::{Job, JobStatus};
use crate::config::settings::AppSettings;
use crate::cwt::CwtFolder;
use crate::scheduler;
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedJobsSnapshot {
    pub jobs: Vec<Job>,
    pub statuses: HashMap<String, JobStatus>,
}

fn cached_jobs_snapshot_path() -> Option<std::path::PathBuf> {
    crate::config::config_dir().map(|dir| dir.join("jobs-cache.json"))
}

fn write_cached_jobs_snapshot(snapshot: &CachedJobsSnapshot) -> Result<(), String> {
    let path = cached_jobs_snapshot_path().ok_or_else(|| "Could not resolve config directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create cache dir: {e}"))?;
    }

    let payload = serde_json::to_vec(snapshot).map_err(|e| format!("Failed to serialize cache: {e}"))?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, payload).map_err(|e| format!("Failed to write cache: {e}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to finalize cache: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_jobs(state: State<AppState>) -> Vec<Job> {
    state.jobs_config.lock().unwrap().jobs.clone()
}

#[tauri::command]
pub fn get_cached_jobs_snapshot() -> Option<CachedJobsSnapshot> {
    let path = cached_jobs_snapshot_path()?;
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

#[tauri::command]
pub fn save_cached_jobs_snapshot(
    jobs: Vec<Job>,
    statuses: HashMap<String, JobStatus>,
) -> Result<(), String> {
    write_cached_jobs_snapshot(&CachedJobsSnapshot { jobs, statuses })
}

#[tauri::command]
pub fn save_job(app: tauri::AppHandle, state: State<AppState>, job: Job) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();

    // Derive slug if not set
    let mut job = job;
    if job.slug.is_empty() {
        // If a job with the same name already exists, reuse its slug
        // to update in place instead of creating a duplicate.
        if let Some(existing) = config.jobs.iter().find(|j| j.name == job.name) {
            job.slug = existing.slug.clone();
        } else {
            job.slug = crate::config::jobs::derive_slug(
                &job.folder_path.as_deref().unwrap_or(&job.name),
                job.job_name.as_deref(),
                &config.jobs,
            );
        }
    }

    config.save_job(&job)?;

    // Refresh in-memory list
    *config = crate::config::jobs::JobsConfig::load();

    // Regenerate all cwt.md context files (agent + per-job)
    let settings = state.settings.lock().unwrap().clone();
    let jobs = config.jobs.clone();
    drop(config);
    ensure_agent_dir(&settings, &jobs);
    regenerate_all_cwt_contexts(&settings, &jobs);

    // Push updated jobs to relay
    crate::relay::push_full_state_if_connected(
        &state.relay,
        &state.jobs_config,
        &state.job_status,
    );

    let _ = app.emit("jobs-changed", ());

    Ok(())
}

#[tauri::command]
pub fn rename_job(
    app: tauri::AppHandle,
    state: State<AppState>,
    old_name: String,
    job: Job,
) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();

    let old_job = config
        .jobs
        .iter()
        .find(|j| j.slug == old_name)
        .cloned()
        .ok_or_else(|| format!("Job not found: {}", old_name))?;

    // Rename in central location if the job_name changed
    let old_jn = old_job.job_name.as_deref().unwrap_or("default");
    let new_jn = job.job_name.as_deref().unwrap_or("default");
    if old_jn != new_jn {
        if let Some(ref fp) = old_job.folder_path {
            if let Some(jobs_dir) = crate::config::config_dir().map(|p| p.join("jobs")) {
                let old_central = jobs_dir.join(&old_job.slug);
                let new_central_slug = crate::config::jobs::derive_slug(
                    fp,
                    Some(new_jn),
                    &config.jobs,
                );
                let new_central = jobs_dir.join(&new_central_slug);
                if old_central.is_dir() && !new_central.exists() {
                    let _ = std::fs::create_dir_all(new_central.parent().unwrap_or(&jobs_dir));
                    let _ = std::fs::rename(&old_central, &new_central);
                }
            }
        }
    }

    // Delete old config entry
    config.delete_job(&old_job.slug)?;

    // Save new job with fresh slug
    let mut new_job = job;
    new_job.slug = String::new();
    // Derive new slug
    new_job.slug = crate::config::jobs::derive_slug(
        &new_job.folder_path.as_deref().unwrap_or(&new_job.name),
        new_job.job_name.as_deref(),
        &config.jobs,
    );
    config.save_job(&new_job)?;

    // Refresh in-memory list
    *config = crate::config::jobs::JobsConfig::load();

    let settings = state.settings.lock().unwrap().clone();
    let jobs = config.jobs.clone();
    drop(config);
    ensure_agent_dir(&settings, &jobs);
    regenerate_all_cwt_contexts(&settings, &jobs);

    // Push updated jobs to relay
    crate::relay::push_full_state_if_connected(
        &state.relay,
        &state.jobs_config,
        &state.job_status,
    );

    let _ = app.emit("jobs-changed", ());

    Ok(())
}

/// Import a job folder (containing job.md) into central config.
/// `source` is the folder with job.md.
/// `dest_cwt` is the project root directory.
/// `job_name` is the job identifier.
#[tauri::command]
pub fn import_job_folder(
    app: tauri::AppHandle,
    state: State<AppState>,
    source: String,
    dest_cwt: String,
    job_name: String,
) -> Result<(), String> {
    let src = std::path::Path::new(&source);
    if !src.join("job.md").exists() {
        return Err("Selected folder does not contain job.md".to_string());
    }

    // dest_cwt is the project root directory
    let project_root_str = dest_cwt.clone();

    // Derive group from project dir name
    let group = std::path::Path::new(&project_root_str)
        .file_name()
        .map(|n: &std::ffi::OsStr| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "default".to_string());

    let mut config = state.jobs_config.lock().unwrap();

    let job = Job {
        name: job_name.clone(),
        job_type: crate::config::jobs::JobType::Job,
        enabled: true,
        path: String::new(),
        args: Vec::new(),
        cron: String::new(),
        secret_keys: Vec::new(),
        env: std::collections::HashMap::new(),
        work_dir: None,
        tmux_session: None,
        aerospace_workspace: None,
        folder_path: Some(project_root_str.clone()),
        job_name: Some(job_name.clone()),
        telegram_chat_id: None,
        telegram_log_mode: crate::config::jobs::TelegramLogMode::OnPrompt,
        telegram_notify: crate::config::jobs::TelegramNotify::default(),
        notify_target: crate::config::jobs::NotifyTarget::None,
        group,
        slug: String::new(),
        skill_paths: Vec::new(),
        params: Vec::new(),
        kill_on_end: true,
        auto_yes: false,
        agent_provider: None,
        added_at: Some(chrono::Utc::now().to_rfc3339()),
    };

    // Copy job.md to central location
    let slug = crate::config::jobs::derive_slug(
        &project_root_str,
        Some(&job_name),
        &config.jobs,
    );
    if let Some(jobs_dir) = crate::config::config_dir().map(|p| p.join("jobs")) {
        let central_dir = jobs_dir.join(&slug);
        let _ = std::fs::create_dir_all(&central_dir);
        let _ = std::fs::copy(src.join("job.md"), central_dir.join("job.md"));
    }
    let mut job = job;
    job.slug = slug;
    config.save_job(&job)?;

    // Refresh
    *config = crate::config::jobs::JobsConfig::load();
    let settings = state.settings.lock().unwrap().clone();
    let jobs = config.jobs.clone();
    drop(config);
    ensure_agent_dir(&settings, &jobs);
    regenerate_all_cwt_contexts(&settings, &jobs);

    crate::relay::push_full_state_if_connected(
        &state.relay,
        &state.jobs_config,
        &state.job_status,
    );

    let _ = app.emit("jobs-changed", ());

    Ok(())
}

#[tauri::command]
pub fn duplicate_job(
    app: tauri::AppHandle,
    state: State<AppState>,
    source_slug: String,
    target_project_path: String,
) -> Result<Job, String> {
    let mut config = state.jobs_config.lock().unwrap();

    let source = config
        .jobs
        .iter()
        .find(|j| j.slug == source_slug)
        .cloned()
        .ok_or_else(|| format!("Job not found: {}", source_slug))?;

    // Read source job.md from central location
    let source_job_md = crate::config::jobs::central_job_md_path(&source_slug);
    let job_md_content = source_job_md
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();

    // Use the group from existing jobs in the target project, falling back to "default"
    let group = config
        .jobs
        .iter()
        .find(|j| j.folder_path.as_deref() == Some(&target_project_path))
        .map(|j| j.group.clone())
        .unwrap_or_else(|| "default".to_string());

    // Generate unique name
    let existing_names: std::collections::HashSet<&str> =
        config.jobs.iter().map(|j| j.name.as_str()).collect();
    let base_name = format!("{}-copy", source.name);
    let copy_name = if !existing_names.contains(base_name.as_str()) {
        base_name
    } else {
        let mut i = 2;
        loop {
            let candidate = format!("{}-copy-{}", source.name, i);
            if !existing_names.contains(candidate.as_str()) {
                break candidate;
            }
            i += 1;
        }
    };

    let job_name = source.job_name.clone().unwrap_or_else(|| "default".to_string());

    // Create new Job cloning config from source
    let mut new_job = Job {
        name: copy_name,
        job_type: source.job_type.clone(),
        enabled: false,
        path: source.path.clone(),
        args: source.args.clone(),
        cron: source.cron.clone(),
        secret_keys: source.secret_keys.clone(),
        env: source.env.clone(),
        work_dir: None,
        tmux_session: source.tmux_session.clone(),
        aerospace_workspace: source.aerospace_workspace.clone(),
        folder_path: Some(target_project_path.clone()),
        job_name: Some(job_name.clone()),
        telegram_chat_id: source.telegram_chat_id,
        telegram_log_mode: source.telegram_log_mode.clone(),
        telegram_notify: source.telegram_notify.clone(),
        notify_target: source.notify_target.clone(),
        group,
        slug: String::new(),
        skill_paths: source.skill_paths.clone(),
        params: source.params.clone(),
        kill_on_end: source.kill_on_end,
        auto_yes: source.auto_yes,
        agent_provider: source.agent_provider,
        added_at: Some(chrono::Utc::now().to_rfc3339()),
    };

    // Derive slug and save
    new_job.slug = crate::config::jobs::derive_slug(
        &target_project_path,
        Some(&job_name),
        &config.jobs,
    );
    config.save_job(&new_job)?;

    // Save job.md to central location
    if !job_md_content.is_empty() {
        if let Some(jobs_dir) = crate::config::config_dir().map(|p| p.join("jobs")) {
            let central_dir = jobs_dir.join(&new_job.slug);
            let _ = std::fs::create_dir_all(&central_dir);
            let _ = std::fs::write(central_dir.join("job.md"), &job_md_content);
        }
    }

    // Refresh in-memory list
    *config = crate::config::jobs::JobsConfig::load();
    let settings = state.settings.lock().unwrap().clone();
    let jobs = config.jobs.clone();

    // Find the saved job to return
    let result = config.jobs.iter().find(|j| j.slug == new_job.slug).cloned()
        .unwrap_or(new_job);

    drop(config);
    ensure_agent_dir(&settings, &jobs);
    regenerate_all_cwt_contexts(&settings, &jobs);

    crate::relay::push_full_state_if_connected(
        &state.relay,
        &state.jobs_config,
        &state.job_status,
    );

    let _ = app.emit("jobs-changed", ());

    Ok(result)
}

#[tauri::command]
pub fn delete_job(app: tauri::AppHandle, state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();

    let slug = config
        .jobs
        .iter()
        .find(|j| j.slug == name)
        .map(|j| j.slug.clone())
        .ok_or_else(|| format!("Job not found: {}", name))?;

    config.delete_job(&slug)?;

    // Refresh in-memory list
    *config = crate::config::jobs::JobsConfig::load();
    drop(config);

    // Push updated jobs to relay
    crate::relay::push_full_state_if_connected(
        &state.relay,
        &state.jobs_config,
        &state.job_status,
    );

    let _ = app.emit("jobs-changed", ());

    Ok(())
}

#[tauri::command]
pub fn toggle_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();
    if let Some(job) = config.jobs.iter_mut().find(|j| j.slug == name) {
        job.enabled = !job.enabled;
        let job = job.clone();
        config.save_job(&job)?;
        *config = crate::config::jobs::JobsConfig::load();
    }
    Ok(())
}

#[tauri::command]
pub async fn run_job_now(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
    params: Option<std::collections::HashMap<String, String>>,
) -> Result<Option<RunAgentResult>, String> {
    let job = {
        let config = state.jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .find(|j| j.slug == name)
            .cloned()
            .ok_or_else(|| format!("Job not found: {}", name))?
    };

    let secrets = Arc::clone(&state.secrets);
    let history = Arc::clone(&state.history);
    let settings = Arc::clone(&state.settings);
    let job_status = Arc::clone(&state.job_status);
    let active_agents = Arc::clone(&state.active_agents);
    let relay = Arc::clone(&state.relay);
    let auto_yes_panes = Arc::clone(&state.auto_yes_panes);
    let params = params.unwrap_or_default();

    if matches!(
        job.job_type,
        crate::config::jobs::JobType::Claude | crate::config::jobs::JobType::Job
    ) {
        let (pane_tx, pane_rx) = tokio::sync::oneshot::channel();
        let app_handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            scheduler::executor::execute_job_with_auto_yes_and_pane_notify(
                &job,
                &secrets,
                &history,
                &settings,
                &job_status,
                "manual",
                &active_agents,
                &relay,
                &params,
                Some(&auto_yes_panes),
                pane_tx,
                Some(app_handle),
            )
            .await;
        });

        match tokio::time::timeout(std::time::Duration::from_secs(10), pane_rx).await {
            Ok(Ok((pane_id, tmux_session))) => Ok(Some(RunAgentResult { pane_id, tmux_session })),
            _ => Ok(None),
        }
    } else {
        let app_handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            scheduler::executor::execute_job_with_auto_yes(
                &job,
                &secrets,
                &history,
                &settings,
                &job_status,
                "manual",
                &active_agents,
                &relay,
                &params,
                Some(&auto_yes_panes),
                Some(app_handle),
            )
            .await;
        });

        Ok(None)
    }
}

#[tauri::command]
pub fn pause_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut status = state.job_status.lock().unwrap();
    match status.get(&name) {
        Some(JobStatus::Running { .. }) => {
            status.insert(name, JobStatus::Paused);
            Ok(())
        }
        _ => Err("Job is not running".to_string()),
    }
}

#[tauri::command]
pub fn resume_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut status = state.job_status.lock().unwrap();
    match status.get(&name) {
        Some(JobStatus::Paused) => {
            status.insert(name, JobStatus::Idle);
            Ok(())
        }
        _ => Err("Job is not paused".to_string()),
    }
}

#[tauri::command]
pub fn sigint_job(state: State<AppState>, name: String) -> Result<(), String> {
    let status = state.job_status.lock().unwrap();
    match status.get(&name).cloned() {
        Some(JobStatus::Running { pane_id: Some(pane_id), .. }) => {
            drop(status);
            crate::tmux::send_sigint_to_pane(&pane_id)?;
            std::thread::sleep(std::time::Duration::from_millis(200));
            crate::tmux::send_sigint_to_pane(&pane_id)
        }
        _ => Err("Job is not running or has no pane".to_string()),
    }
}

#[tauri::command]
pub fn stop_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut status = state.job_status.lock().unwrap();
    match status.get(&name).cloned() {
        Some(JobStatus::Running { pane_id: Some(pane_id), .. }) => {
            let _ = crate::tmux::kill_pane(&pane_id);
            status.insert(name, JobStatus::Idle);
            Ok(())
        }
        Some(JobStatus::Running { .. }) | Some(JobStatus::Paused) => {
            status.insert(name, JobStatus::Idle);
            Ok(())
        }
        _ => Err("Job is not running".to_string()),
    }
}

#[tauri::command]
pub async fn restart_job(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
    params: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    let job = {
        let config = state.jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .find(|j| j.slug == name)
            .cloned()
            .ok_or_else(|| format!("Job not found: {}", name))?
    };

    let secrets = Arc::clone(&state.secrets);
    let history = Arc::clone(&state.history);
    let settings = Arc::clone(&state.settings);
    let job_status = Arc::clone(&state.job_status);
    let active_agents = Arc::clone(&state.active_agents);
    let relay = Arc::clone(&state.relay);
    let auto_yes_panes = Arc::clone(&state.auto_yes_panes);
    let params = params.unwrap_or_default();

    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        scheduler::executor::execute_job_with_auto_yes(
            &job,
            &secrets,
            &history,
            &settings,
            &job_status,
            "restart",
            &active_agents,
            &relay,
            &params,
            Some(&auto_yes_panes),
            Some(app_handle),
        )
        .await;
    });

    Ok(())
}

#[tauri::command]
pub fn open_job_editor(
    state: State<AppState>,
    folder_path: String,
    editor: Option<String>,
    file_name: Option<String>,
    job_name: Option<String>,
) -> Result<(), String> {
    let preferred_editor = editor.unwrap_or_else(|| {
        let s = state.settings.lock().unwrap();
        s.preferred_editor.clone()
    });

    let jn = job_name.as_deref().unwrap_or("default");
    let target_file = file_name.as_deref().unwrap_or("job.md");

    // Read/write from central location
    let slug = crate::config::jobs::derive_slug(&folder_path, Some(jn), &[]);
    let file_path = if target_file == "job.md" {
        crate::config::jobs::central_job_md_path(&slug)
            .ok_or("Could not determine config directory")?
    } else if target_file == "context.md" {
        crate::config::jobs::central_job_context_path(&slug)
            .ok_or("Could not determine config directory")?
    } else {
        // Other files (scripts) live in the central job dir
        let jobs_dir = crate::config::jobs::JobsConfig::jobs_dir_public()
            .ok_or("Could not determine config directory")?;
        jobs_dir.join(&slug).join(target_file)
    };

    // Create job.md with template if it doesn't exist (only for job.md)
    if target_file == "job.md" && !file_path.exists() {
        if let Some(parent) = file_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let template = "# Job Directions\n\nDescribe what the bot should do here.\n";
        std::fs::write(&file_path, template)
            .map_err(|e| format!("Failed to create job.md: {}", e))?;
    }

    let file_path_str = file_path.display().to_string();

    match preferred_editor.as_str() {
        "code" => {
            std::process::Command::new("code")
                .args([&folder_path, "--goto", &file_path_str])
                .spawn()
                .map_err(|e| format!("Failed to open VS Code: {}", e))?;
        }
        "codium" => {
            std::process::Command::new("codium")
                .args([&folder_path, "--goto", &file_path_str])
                .spawn()
                .map_err(|e| format!("Failed to open VSCodium: {}", e))?;
        }
        "zed" => {
            std::process::Command::new("zed")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open Zed: {}", e))?;
        }
        "subl" => {
            std::process::Command::new("subl")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open Sublime Text: {}", e))?;
        }
        // Terminal-based editors: nvim, vim, hx, emacs
        editor => {
            let cmd = format!("{} {}", editor, file_path_str);
            crate::terminal::open_in_terminal(&cmd)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn open_job_in_editor(state: State<AppState>, name: String) -> Result<(), String> {
    let config = state.jobs_config.lock().unwrap();
    let job = config
        .jobs
        .iter()
        .find(|j| j.name == name)
        .ok_or_else(|| format!("Job '{}' not found", name))?;

    // folder_path is the project root; use it directly
    let folder = job
        .folder_path
        .clone()
        .or_else(|| job.work_dir.clone())
        .ok_or_else(|| "Job has no folder path or working directory".to_string())?;

    let preferred_editor = {
        let s = state.settings.lock().unwrap();
        s.preferred_editor.clone()
    };

    match preferred_editor.as_str() {
        "code" => {
            std::process::Command::new("code")
                .arg(&folder)
                .spawn()
                .map_err(|e| format!("Failed to open VS Code: {}", e))?;
        }
        "codium" => {
            std::process::Command::new("codium")
                .arg(&folder)
                .spawn()
                .map_err(|e| format!("Failed to open VSCodium: {}", e))?;
        }
        "zed" => {
            std::process::Command::new("zed")
                .arg(&folder)
                .spawn()
                .map_err(|e| format!("Failed to open Zed: {}", e))?;
        }
        "subl" => {
            std::process::Command::new("subl")
                .arg(&folder)
                .spawn()
                .map_err(|e| format!("Failed to open Sublime Text: {}", e))?;
        }
        // Terminal-based editors: nvim, vim, hx, emacs
        editor => {
            let cmd = format!("cd {} && {}", folder, editor);
            crate::terminal::open_in_terminal(&cmd)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn init_cwt_folder(folder_path: String, job_name: Option<String>) -> Result<CwtFolder, String> {
    // folder_path is the project root
    let project_root = std::path::Path::new(&folder_path);
    let job_name = job_name.as_deref().unwrap_or("default");

    // Central job directory is created when the job is saved (via save_job)
    // Just ensure the CwtFolder structure is valid
    CwtFolder::from_path_with_job(project_root, job_name)
}

#[tauri::command]
pub fn read_cwt_entry(folder_path: String, job_name: Option<String>) -> Result<String, String> {
    // Read job.md from central location using slug derived from folder_path + job_name
    let jn = job_name.as_deref().unwrap_or("default");
    let slug = crate::config::jobs::derive_slug(&folder_path, Some(jn), &[]);
    let job_md = crate::config::jobs::central_job_md_path(&slug)
        .ok_or("Could not determine config directory")?;
    if !job_md.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&job_md)
        .map_err(|e| format!("Failed to read {}: {}", job_md.display(), e))
}

#[tauri::command]
pub fn write_cwt_entry(folder_path: String, job_name: Option<String>, content: String) -> Result<(), String> {
    // Write job.md to central location
    let jn = job_name.as_deref().unwrap_or("default");
    let slug = crate::config::jobs::derive_slug(&folder_path, Some(jn), &[]);
    let job_md = crate::config::jobs::central_job_md_path(&slug)
        .ok_or("Could not determine config directory")?;
    if let Some(parent) = job_md.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&job_md, content)
        .map_err(|e| format!("Failed to write {}: {}", job_md.display(), e))
}

#[tauri::command]
pub fn read_cwt_context(folder_path: String, job_name: Option<String>) -> Result<String, String> {
    // Read auto-generated context from central: ~/.config/clawtab/jobs/{slug}/context.md
    let jn = job_name.as_deref().unwrap_or("default");
    let slug = crate::config::jobs::derive_slug(&folder_path, Some(jn), &[]);
    let context_md = crate::config::jobs::central_job_context_path(&slug)
        .ok_or("Could not determine config directory")?;
    if !context_md.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&context_md)
        .map_err(|e| format!("Failed to read {}: {}", context_md.display(), e))
}

#[tauri::command]
pub fn read_cwt_shared(folder_path: String) -> Result<String, String> {
    // Read shared project context from central: ~/.config/clawtab/jobs/{project-slug}/context.md
    let slug = crate::config::jobs::derive_slug(&folder_path, Some("default"), &[]);
    let context_md = crate::config::jobs::central_project_context_path(&slug)
        .ok_or("Could not determine config directory")?;
    if !context_md.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&context_md)
        .map_err(|e| format!("Failed to read {}: {}", context_md.display(), e))
}

#[tauri::command]
pub fn write_cwt_shared(folder_path: String, content: String) -> Result<(), String> {
    // Write shared project context to central: ~/.config/clawtab/jobs/{project-slug}/context.md
    let slug = crate::config::jobs::derive_slug(&folder_path, Some("default"), &[]);
    let context_md = crate::config::jobs::central_project_context_path(&slug)
        .ok_or("Could not determine config directory")?;
    if let Some(parent) = context_md.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&context_md, content)
        .map_err(|e| format!("Failed to write {}: {}", context_md.display(), e))
}

#[tauri::command]
pub fn derive_job_slug(
    state: State<AppState>,
    folder_path: String,
    job_name: Option<String>,
) -> String {
    let config = state.jobs_config.lock().unwrap();
    crate::config::jobs::derive_slug(&folder_path, job_name.as_deref(), &config.jobs)
}

/// Generate the auto-generated context for the agent directory.
/// Contains workspace info, available tools, and Telegram communication instructions.
fn generate_agent_cwt_context(settings: &AppSettings, jobs: &[Job], chat_id: Option<i64>) -> String {
    let mut out = String::new();

    out.push_str("<!-- Auto-generated by ClawTab. Regenerated on agent start. -->\n");
    out.push_str("# ClawTab Telegram Agent\n\n");
    out.push_str("You are the ClawTab interactive agent. The user communicates with you through Telegram.\n\n");

    // Communication protocol -- this is the most important section
    out.push_str("## Communication Protocol\n\n");
    out.push_str("IMPORTANT: You MUST send ALL your responses and questions to the user via Telegram using curl.\n");
    out.push_str("The user cannot see your terminal output. Telegram is your ONLY communication channel.\n\n");

    let has_token = settings.telegram.as_ref().map_or(false, |tg| !tg.bot_token.is_empty());
    let cid = chat_id.or_else(|| {
        settings.telegram.as_ref().and_then(|tg| tg.chat_ids.first().copied())
    });

    if has_token {
        if let Some(cid) = cid {
            out.push_str("### Sending messages\n\n");
            out.push_str("Send every response, question, status update, or result to Telegram:\n\n");
            out.push_str("```bash\n");
            out.push_str(&format!(
                "curl -s -X POST \"https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{{\"chat_id\": {}, \"text\": \"Your message here\"}}'\n",
                cid
            ));
            out.push_str("```\n\n");

            out.push_str("### Receiving messages\n\n");
            out.push_str("The user's follow-up messages are typed into your terminal input automatically by ClawTab.\n");
            out.push_str("After sending a question or completing a task, simply wait -- the user's reply will appear as your next prompt input.\n\n");
        }
    }

    out.push_str("### Rules\n\n");
    out.push_str("- ALWAYS send your answers and questions via the Telegram curl command above.\n");
    out.push_str("- After completing a task or asking a question, wait for the next input.\n");
    out.push_str("- Do NOT terminate or exit unless the user explicitly asks you to.\n");
    out.push_str("- Keep messages concise. For long output, summarize and offer to share details.\n");
    out.push_str("- Only operate within the allowed directories listed below.\n");

    // Collect unique allowed directories from jobs
    let mut dirs: Vec<String> = Vec::new();
    for job in jobs {
        if let Some(ref fp) = job.folder_path {
            if !dirs.contains(fp) {
                dirs.push(fp.clone());
            }
        }
        if let Some(ref wd) = job.work_dir {
            if !dirs.contains(wd) {
                dirs.push(wd.clone());
            }
        }
    }
    if !settings.default_work_dir.is_empty() && !dirs.contains(&settings.default_work_dir) {
        dirs.push(settings.default_work_dir.clone());
    }

    out.push_str("\n## Allowed Directories\n\n");
    for d in &dirs {
        out.push_str(&format!("- `{}`\n", d));
    }

    if let Some(config_dir) = crate::config::config_dir() {
        out.push_str(&format!("- `{}` (ClawTab config)\n", config_dir.display()));
    }

    // Workspace listing
    if !jobs.is_empty() {
        out.push_str("\n## Configured Jobs\n\n");
        for job in jobs {
            let jt = match job.job_type {
                crate::config::jobs::JobType::Binary => "bin",
                crate::config::jobs::JobType::Claude => "claude",
                crate::config::jobs::JobType::Job => if job.cron.is_empty() { "job" } else { "cronjob" },
            };
            let dir = job.folder_path.as_deref()
                .or(job.work_dir.as_deref())
                .unwrap_or("-");
            out.push_str(&format!("- `{}` [{}] dir: `{}`\n", job.name, jt, dir));
        }
    }

    out.push_str("\n## Job Management CLI\n\n");
    out.push_str("`cwtctl` is available for managing ClawTab jobs:\n\n");
    out.push_str("```\n");
    out.push_str("cwtctl ping           # Check if ClawTab daemon is running\n");
    out.push_str("cwtctl list           # List all configured jobs\n");
    out.push_str("cwtctl status         # Show status of all jobs\n");
    out.push_str("cwtctl run <name>     # Run a job immediately\n");
    out.push_str("cwtctl pause <name>   # Pause a running job\n");
    out.push_str("cwtctl resume <name>  # Resume a paused job\n");
    out.push_str("cwtctl restart <name> # Restart a job\n");
    out.push_str("```\n");

    out
}

/// Write `.claude/settings.local.json` in the given directory with default
/// permissions for automated Claude Code jobs (curl, cwtctl, kill, etc.).
fn write_claude_settings(dir: &std::path::Path) {
    let claude_dir = dir.join(".claude");
    if let Err(e) = std::fs::create_dir_all(&claude_dir) {
        log::warn!("Failed to create .claude dir in {}: {}", dir.display(), e);
        return;
    }

    let settings = serde_json::json!({
        "permissions": {
            "allow": [
                "Bash(curl *)",
                "Bash(cwtctl *)",
                "Bash(cwtctl)",
                "Bash(kill *)",
                "Bash(cat *)",
                "Bash(ls *)",
                "Bash(find *)",
                "Bash(grep *)",
                "Bash(rg *)",
                "Bash(git *)",
                "Bash(mkdir *)",
                "Bash(cp *)",
                "Bash(mv *)",
                "Bash(head *)",
                "Bash(tail *)",
                "Bash(wc *)",
                "Bash(sort *)",
                "Bash(uniq *)",
                "Bash(jq *)",
                "Bash(sed *)",
                "Bash(awk *)",
                "Bash(chmod *)",
                "Bash(osascript *)",
                "Bash(echo *)",
                "Bash(printf *)",
                "Bash(test *)",
                "Bash(touch *)",
                "Bash(date *)",
                "Bash(env *)",
                "Bash(which *)",
                "Bash(pwd)",
                "Bash(cd *)",
                "Bash(npm *)",
                "Bash(npx *)",
                "Bash(node *)",
                "Bash(bun *)",
                "Bash(python *)",
                "Bash(python3 *)",
                "Bash(pip *)",
                "Bash(pip3 *)",
                "Bash(cargo *)",
                "Bash(rustc *)",
                "Bash(docker *)",
                "Bash(psql *)",
                "Bash(sqlite3 *)",
                "Bash(tar *)",
                "Bash(zip *)",
                "Bash(unzip *)",
                "Bash(wget *)",
                "Bash(diff *)",
                "Bash(xargs *)",
                "Bash(tee *)",
                "Bash(cut *)",
                "Bash(tr *)",
                "Bash(basename *)",
                "Bash(dirname *)",
                "Bash(realpath *)",
                "Bash(readlink *)",
                "Bash(stat *)",
                "Bash(file *)",
                "Bash(du *)",
                "Bash(df *)",
                "Bash(uname *)",
                "Bash(whoami)",
                "Bash(hostname)",
                "Bash(brew *)",
                "Read(**)",
                "Edit(**)",
                "Write(**)",
                "WebSearch(*)",
                "WebFetch(*)",
            ]
        }
    });

    let path = claude_dir.join("settings.local.json");
    match serde_json::to_string_pretty(&settings) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                log::warn!("Failed to write {}: {}", path.display(), e);
            }
        }
        Err(e) => log::warn!("Failed to serialize claude settings: {}", e),
    }
}

/// Ensure the agent directory exists with current config.
/// Writes `cwt.md` (auto-generated) directly in the agent dir.
pub fn ensure_agent_dir(settings: &AppSettings, jobs: &[Job]) {
    let agent_dir = agent_dir_path();
    if let Err(e) = std::fs::create_dir_all(&agent_dir) {
        log::warn!("Failed to create agent dir: {}", e);
        return;
    }

    // Write auto-generated context to cwt.md (always overwritten)
    let context = generate_agent_cwt_context(settings, jobs, None);
    let cwt_md_path = agent_dir.join("cwt.md");
    if let Err(e) = std::fs::write(&cwt_md_path, context) {
        log::warn!("Failed to write agent cwt.md: {}", e);
    }

    // Write Claude Code permissions
    write_claude_settings(&agent_dir);

    // Clean up old files from previous formats
    for old in &["CLAUDE.md"] {
        let p = agent_dir.join(old);
        if p.is_file() {
            let _ = std::fs::remove_file(&p);
        }
    }
    // Clean up old .cwt/ nested structure
    let old_cwt = agent_dir.join(".cwt");
    if old_cwt.is_dir() {
        let _ = std::fs::remove_dir_all(&old_cwt);
    }
}

/// Regenerate context.md for every folder job in central config.
/// Also writes `.claude/settings.local.json` in each project root / work_dir.
pub fn regenerate_all_cwt_contexts(settings: &AppSettings, jobs: &[Job]) {
    let mut settings_written: Vec<std::path::PathBuf> = Vec::new();

    for job in jobs {
        match job.job_type {
            crate::config::jobs::JobType::Job => {
                if let Some(ref folder_path) = job.folder_path {
                    let content = generate_cwt_context(job, settings);
                    // Write context.md to central: ~/.config/clawtab/jobs/{slug}/context.md
                    if let Some(context_path) = crate::config::jobs::central_job_context_path(&job.slug) {
                        if let Some(parent) = context_path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        if let Err(e) = std::fs::write(&context_path, content) {
                            log::warn!("Failed to write context.md for '{}': {}", job.name, e);
                        }
                    }

                    // Write Claude Code permissions in the project root
                    let project_root = std::path::Path::new(folder_path);
                    let pr = project_root.to_path_buf();
                    if !settings_written.contains(&pr) {
                        write_claude_settings(project_root);
                        settings_written.push(pr);
                    }
                }
            }
            crate::config::jobs::JobType::Claude => {
                // Claude jobs run from work_dir; write permissions there
                if let Some(ref wd) = job.work_dir {
                    let dir = std::path::PathBuf::from(wd);
                    if !settings_written.contains(&dir) {
                        write_claude_settings(&dir);
                        settings_written.push(dir);
                    }
                }
            }
            _ => {}
        }
    }

    // Also write to default_work_dir if set
    if !settings.default_work_dir.is_empty() {
        let dir = std::path::PathBuf::from(&settings.default_work_dir);
        if !settings_written.contains(&dir) && dir.is_dir() {
            write_claude_settings(&dir);
        }
    }
}

/// Returns the path to the agent working directory.
pub fn agent_dir_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config")
        .join("clawtab")
        .join("agent")
}

/// Open an agent file (cwt.md) in the user's preferred editor.
#[tauri::command]
pub fn open_agent_editor(state: State<AppState>, file_name: Option<String>) -> Result<(), String> {
    let preferred_editor = {
        let s = state.settings.lock().unwrap();
        s.preferred_editor.clone()
    };

    let agent_dir = agent_dir_path();
    let target = file_name.as_deref().unwrap_or("job.md");
    let file_path = agent_dir.join(target);

    // Create job.md with template if it doesn't exist
    if target == "job.md" && !file_path.exists() {
        let template = "# Agent Directions\n\nDescribe what the agent should do here.\n";
        std::fs::write(&file_path, template)
            .map_err(|e| format!("Failed to create job.md: {}", e))?;
    }

    let file_path_str = file_path.display().to_string();
    let folder = agent_dir.display().to_string();

    match preferred_editor.as_str() {
        "code" => {
            std::process::Command::new("code")
                .args([&folder, "--goto", &file_path_str])
                .spawn()
                .map_err(|e| format!("Failed to open VS Code: {}", e))?;
        }
        "codium" => {
            std::process::Command::new("codium")
                .args([&folder, "--goto", &file_path_str])
                .spawn()
                .map_err(|e| format!("Failed to open VSCodium: {}", e))?;
        }
        "zed" => {
            std::process::Command::new("zed")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open Zed: {}", e))?;
        }
        "subl" => {
            std::process::Command::new("subl")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open Sublime Text: {}", e))?;
        }
        editor => {
            let cmd = format!("{} {}", editor, file_path_str);
            crate::terminal::open_in_terminal(&cmd)?;
        }
    }

    Ok(())
}

/// Read the agent's auto-generated context (cwt.md in agent dir root).
#[tauri::command]
pub fn read_agent_context() -> Result<String, String> {
    let path = agent_dir_path().join("cwt.md");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))
}

fn generate_cwt_context(job: &Job, _settings: &AppSettings) -> String {
    let mut out = String::new();

    out.push_str("<!-- Auto-generated by ClawTab. Regenerated on settings/jobs change. -->\n");
    out.push_str("# ClawTab Environment\n\n");
    out.push_str("You are running as an automated Claude Code job.\n");
    out.push_str(&format!("Job name: `{}`\n", job.name));

    out.push_str("\n## Rules\n\n");
    out.push_str("- Only edit and look for files in the current directory.\n");
    out.push_str("- The job directions are managed by ClawTab (stored centrally).\n");
    out.push_str("- Shared project context is loaded automatically from central config.\n");
    out.push_str("- Notifications are handled by ClawTab. Do not send notifications directly.\n");
    if job.kill_on_end {
        out.push_str("- When your task is fully complete and you need no further input, terminate your own process by running: `kill $PPID`\n");
    }

    out.push_str("\n## Job Management CLI\n\n");
    out.push_str("`cwtctl` is available for managing ClawTab jobs:\n\n");
    out.push_str("```\n");
    out.push_str("cwtctl ping           # Check if ClawTab daemon is running\n");
    out.push_str("cwtctl list           # List all configured jobs\n");
    out.push_str("cwtctl status         # Show status of all jobs\n");
    out.push_str("cwtctl run <name>     # Run a job immediately\n");
    out.push_str("cwtctl pause <name>   # Pause a running job\n");
    out.push_str("cwtctl resume <name>  # Resume a paused job\n");
    out.push_str("cwtctl restart <name> # Restart a job\n");
    out.push_str("```\n");

    // Env vars section: only if any secrets configured
    if !job.secret_keys.is_empty() {
        out.push_str("\n## Environment Variables\n\n");
        out.push_str("The following secrets are injected as env vars at runtime:\n\n");
        for key in &job.secret_keys {
            out.push_str(&format!("- `${}`\n", key));
        }
    }

    out
}

/// Build a synthetic `Job` for running Claude as an ad-hoc interactive agent.
/// Writes enriched prompt to `~/.config/clawtab/agent/.agent-prompt.md`
/// and returns a Job that can be passed to `execute_job`.
///
/// When `target_dir` is provided, the agent runs in that directory instead of the
/// default agent dir. The job name/slug become `agent-<folder>` so multiple
/// per-folder agents can coexist.
pub fn build_agent_job(
    prompt: &str,
    chat_id: Option<i64>,
    settings: &AppSettings,
    jobs: &[Job],
    target_dir: Option<&str>,
    provider: Option<ProcessProvider>,
) -> Result<Job, String> {
    let agent_dir = agent_dir_path();
    std::fs::create_dir_all(&agent_dir)
        .map_err(|e| format!("Failed to create agent dir: {}", e))?;

    // For group/folder agents, skip the agent cwt.md - just run claude in that folder
    let enriched = if target_dir.is_some() {
        prompt.to_string()
    } else {
        // Regenerate the auto-generated context with the specific chat_id
        let context = generate_agent_cwt_context(settings, jobs, chat_id);
        let cwt_md_path = agent_dir.join("cwt.md");
        std::fs::write(&cwt_md_path, &context)
            .map_err(|e| format!("Failed to write agent cwt.md: {}", e))?;
        format!("@{}\n\n{}", cwt_md_path.display(), prompt)
    };

    // Derive name/slug and work_dir from target_dir
    let (job_name, job_slug, work_dir) = if let Some(dir) = target_dir {
        let project_dir = std::path::Path::new(dir);
        let folder = project_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("agent");
        let slug = format!("agent-{}", folder);
        (slug.clone(), slug, project_dir.to_string_lossy().to_string())
    } else {
        ("agent".to_string(), "agent".to_string(), agent_dir.display().to_string())
    };

    // Write prompt to a per-agent file to avoid collisions
    let prompt_filename = format!(".agent-prompt-{}.md", job_slug);
    let prompt_path = agent_dir.join(&prompt_filename);
    std::fs::write(&prompt_path, &enriched)
        .map_err(|e| format!("Failed to write agent prompt: {}", e))?;

    Ok(Job {
        name: job_name,
        job_type: crate::config::jobs::JobType::Claude,
        enabled: true,
        path: prompt_path.display().to_string(),
        args: Vec::new(),
        cron: String::new(),
        secret_keys: Vec::new(),
        env: std::collections::HashMap::new(),
        work_dir: Some(work_dir),
        tmux_session: None,
        aerospace_workspace: None,
        folder_path: None,
        job_name: Some("default".to_string()),
        telegram_chat_id: chat_id,
        telegram_log_mode: crate::config::jobs::TelegramLogMode::OnPrompt,
        telegram_notify: crate::config::jobs::TelegramNotify::default(),
        notify_target: if chat_id.is_some() {
            crate::config::jobs::NotifyTarget::Telegram
        } else {
            crate::config::jobs::NotifyTarget::None
        },
        group: "agent".to_string(),
        slug: job_slug,
        skill_paths: Vec::new(),
        params: Vec::new(),
        kill_on_end: true,
        auto_yes: false,
        agent_provider: provider,
        added_at: Some(chrono::Utc::now().to_rfc3339()),
    })
}

#[derive(serde::Serialize)]
pub struct RunAgentResult {
    pub pane_id: String,
    pub tmux_session: String,
}

#[tauri::command]
pub async fn run_agent(
    state: State<'_, AppState>,
    prompt: String,
    work_dir: Option<String>,
    provider: Option<ProcessProvider>,
) -> Result<Option<RunAgentResult>, String> {
    let (settings, jobs) = {
        let s = state.settings.lock().unwrap().clone();
        let j = state.jobs_config.lock().unwrap().jobs.clone();
        (s, j)
    };
    let job = build_agent_job(&prompt, None, &settings, &jobs, work_dir.as_deref(), provider)?;

    let secrets = Arc::clone(&state.secrets);
    let history = Arc::clone(&state.history);
    let settings_arc = Arc::clone(&state.settings);
    let job_status = Arc::clone(&state.job_status);
    let active_agents = Arc::clone(&state.active_agents);
    let relay = Arc::clone(&state.relay);

    let (pane_tx, pane_rx) = tokio::sync::oneshot::channel();

    tauri::async_runtime::spawn(async move {
        scheduler::executor::execute_job_with_pane_notify(
            &job, &secrets, &history, &settings_arc, &job_status, "manual", &active_agents,
            &relay, &std::collections::HashMap::new(), pane_tx, None,
        )
        .await;
    });

    // Wait for the pane to be created (up to 10s)
    match tokio::time::timeout(std::time::Duration::from_secs(10), pane_rx).await {
        Ok(Ok((pane_id, tmux_session))) => Ok(Some(RunAgentResult { pane_id, tmux_session })),
        _ => Ok(None),
    }
}
