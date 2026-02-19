use std::sync::Arc;

use tauri::State;

use crate::config::jobs::{Job, JobStatus};
use crate::config::settings::AppSettings;
use crate::cwt::CwtFolder;
use crate::scheduler;
use crate::AppState;

#[tauri::command]
pub fn get_jobs(state: State<AppState>) -> Vec<Job> {
    state.jobs_config.lock().unwrap().jobs.clone()
}

#[tauri::command]
pub fn save_job(state: State<AppState>, job: Job) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();

    // Derive slug if not set
    let mut job = job;
    if job.slug.is_empty() {
        job.slug = crate::config::jobs::derive_slug(
            &job.folder_path.as_deref().unwrap_or(&job.name),
            job.job_name.as_deref(),
            &config.jobs,
        );
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

    Ok(())
}

#[tauri::command]
pub fn delete_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();

    let slug = config
        .jobs
        .iter()
        .find(|j| j.name == name)
        .map(|j| j.slug.clone())
        .ok_or_else(|| format!("Job not found: {}", name))?;

    config.delete_job(&slug)?;

    // Refresh in-memory list
    *config = crate::config::jobs::JobsConfig::load();
    Ok(())
}

#[tauri::command]
pub fn toggle_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();
    if let Some(job) = config.jobs.iter_mut().find(|j| j.name == name) {
        job.enabled = !job.enabled;
        let job = job.clone();
        config.save_job(&job)?;
        *config = crate::config::jobs::JobsConfig::load();
    }
    Ok(())
}

#[tauri::command]
pub async fn run_job_now(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let job = {
        let config = state.jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .find(|j| j.name == name)
            .cloned()
            .ok_or_else(|| format!("Job not found: {}", name))?
    };

    let secrets = Arc::clone(&state.secrets);
    let history = Arc::clone(&state.history);
    let settings = Arc::clone(&state.settings);
    let job_status = Arc::clone(&state.job_status);

    tauri::async_runtime::spawn(async move {
        scheduler::executor::execute_job(
            &job,
            &secrets,
            &history,
            &settings,
            &job_status,
            "manual",
        )
        .await;
    });

    Ok(())
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
pub async fn restart_job(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let job = {
        let config = state.jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .find(|j| j.name == name)
            .cloned()
            .ok_or_else(|| format!("Job not found: {}", name))?
    };

    let secrets = Arc::clone(&state.secrets);
    let history = Arc::clone(&state.history);
    let settings = Arc::clone(&state.settings);
    let job_status = Arc::clone(&state.job_status);

    tauri::async_runtime::spawn(async move {
        scheduler::executor::execute_job(
            &job,
            &secrets,
            &history,
            &settings,
            &job_status,
            "restart",
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

    // Build file path: {folder_path}/{job_name}/{target_file}
    let file_path = std::path::Path::new(&folder_path).join(jn).join(target_file);

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

    // For folder jobs, open the parent of .cwt; otherwise use work_dir
    let folder = job
        .folder_path
        .as_ref()
        .and_then(|p| {
            let path = std::path::Path::new(p);
            // If path ends in .cwt, go up to the project root
            if path.file_name().map(|n| n == ".cwt").unwrap_or(false) {
                path.parent().map(|p| p.display().to_string())
            } else {
                Some(p.clone())
            }
        })
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
    let cwt_root = std::path::Path::new(&folder_path);
    let job_name = job_name.as_deref().unwrap_or("default");

    // Create .cwt/ root if it doesn't exist
    if !cwt_root.exists() {
        std::fs::create_dir_all(cwt_root)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // Lazy migration: move .cwt/job.md -> .cwt/default/job.md if needed
    crate::config::jobs::migrate_cwt_root(cwt_root);

    // Create job subfolder
    let job_dir = cwt_root.join(job_name);
    if !job_dir.exists() {
        std::fs::create_dir_all(&job_dir)
            .map_err(|e| format!("Failed to create job directory: {}", e))?;
    }

    let job_md = job_dir.join("job.md");
    if !job_md.exists() {
        let template = "# Job Directions\n\nDescribe what the bot should do here.\n";
        std::fs::write(&job_md, template)
            .map_err(|e| format!("Failed to create job.md: {}", e))?;
    }

    CwtFolder::from_path_with_job(cwt_root, job_name)
}

#[tauri::command]
pub fn read_cwt_entry(folder_path: String, job_name: Option<String>) -> Result<String, String> {
    let cwt_root = std::path::Path::new(&folder_path);
    let job_name = job_name.as_deref().unwrap_or("default");
    let folder = CwtFolder::from_path_with_job(cwt_root, job_name)?;
    if !folder.has_entry_point {
        return Ok(String::new());
    }
    folder.read_entry_point()
}

#[tauri::command]
pub fn read_cwt_context(folder_path: String, job_name: Option<String>) -> Result<String, String> {
    let cwt_root = std::path::Path::new(&folder_path);
    let jn = job_name.as_deref().unwrap_or("default");
    let cwt_md = cwt_root.join(jn).join("cwt.md");
    if !cwt_md.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&cwt_md)
        .map_err(|e| format!("Failed to read {}: {}", cwt_md.display(), e))
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

/// Generate the CLAUDE.md for the agent bot directory (~/.config/clawdtab/agent/).
/// This gives the agent context about allowed directories and available tools.
pub fn generate_agent_claude_md(settings: &AppSettings, jobs: &[Job]) -> String {
    let mut out = String::new();

    out.push_str("<!-- Auto-generated by ClawdTab. Regenerated on settings/jobs change. -->\n");
    out.push_str("# ClawdTab Agent Bot\n\n");
    out.push_str("You are the ClawdTab agentic bot, controlled via Telegram.\n\n");

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
    // Always include default work dir
    if !settings.default_work_dir.is_empty() && !dirs.contains(&settings.default_work_dir) {
        dirs.push(settings.default_work_dir.clone());
    }

    out.push_str("## Allowed Directories\n\n");
    out.push_str("You have read and write access to these configured job directories:\n\n");
    for d in &dirs {
        out.push_str(&format!("- `{}`\n", d));
    }

    // Config dir
    if let Some(config_dir) = crate::config::config_dir() {
        out.push_str(&format!("\nYou also have access to ClawdTab config at `{}`\n", config_dir.display()));
    }

    out.push_str("\n## Rules\n\n");
    out.push_str("- Only operate within the allowed directories listed above.\n");
    out.push_str("- Do not modify system files outside these directories.\n");
    out.push_str("- Use cwtctl to interact with ClawdTab jobs.\n");

    out.push_str("\n## Job Management CLI\n\n");
    out.push_str("`cwtctl` is available for managing ClawdTab jobs:\n\n");
    out.push_str("```\n");
    out.push_str("cwtctl ping           # Check if ClawdTab daemon is running\n");
    out.push_str("cwtctl list           # List all configured jobs\n");
    out.push_str("cwtctl status         # Show status of all jobs\n");
    out.push_str("cwtctl run <name>     # Run a job immediately\n");
    out.push_str("cwtctl pause <name>   # Pause a running job\n");
    out.push_str("cwtctl resume <name>  # Resume a paused job\n");
    out.push_str("cwtctl restart <name> # Restart a job\n");
    out.push_str("```\n");

    out
}

/// Ensure the agent directory and CLAUDE.md exist with current config.
pub fn ensure_agent_dir(settings: &AppSettings, jobs: &[Job]) {
    let agent_dir = agent_dir_path();
    if let Err(e) = std::fs::create_dir_all(&agent_dir) {
        log::warn!("Failed to create agent dir: {}", e);
        return;
    }

    let claude_md = generate_agent_claude_md(settings, jobs);
    let claude_md_path = agent_dir.join("CLAUDE.md");
    if let Err(e) = std::fs::write(&claude_md_path, claude_md) {
        log::warn!("Failed to write agent CLAUDE.md: {}", e);
    }
}

/// Regenerate cwt.md context file for every folder job's .cwt/{job_name}/ directory.
pub fn regenerate_all_cwt_contexts(settings: &AppSettings, jobs: &[Job]) {
    for job in jobs {
        if job.job_type != crate::config::jobs::JobType::Folder {
            continue;
        }
        if let Some(ref folder_path) = job.folder_path {
            let jn = job.job_name.as_deref().unwrap_or("default");
            let content = generate_cwt_context(job, settings);
            let job_dir = std::path::Path::new(folder_path).join(jn);
            if !job_dir.exists() {
                let _ = std::fs::create_dir_all(&job_dir);
            }
            let path = job_dir.join("cwt.md");
            if let Err(e) = std::fs::write(&path, content) {
                log::warn!("Failed to write cwt.md for '{}': {}", job.name, e);
            }
        }
    }
}

/// Returns the path to the agent working directory.
pub fn agent_dir_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config")
        .join("clawdtab")
        .join("agent")
}

fn generate_cwt_context(job: &Job, settings: &AppSettings) -> String {
    let mut out = String::new();
    let jn = job.job_name.as_deref().unwrap_or("default");

    out.push_str("<!-- Auto-generated by ClawdTab. Regenerated on settings/jobs change. -->\n");
    out.push_str("# ClawdTab Environment\n\n");
    out.push_str("You are running as an automated Claude Code job.\n");
    out.push_str(&format!("Job name: `{}`\n", job.name));

    out.push_str("\n## Rules\n\n");
    out.push_str("- Only edit and look for files in the current directory.\n");
    out.push_str(&format!("- The job directions are in `.cwt/{}/job.md`.\n", jn));
    out.push_str("- Shared project context is in `.cwt/cwt.md` (user-managed).\n");

    out.push_str("\n## Job Management CLI\n\n");
    out.push_str("`cwtctl` is available for managing ClawdTab jobs:\n\n");
    out.push_str("```\n");
    out.push_str("cwtctl ping           # Check if ClawdTab daemon is running\n");
    out.push_str("cwtctl list           # List all configured jobs\n");
    out.push_str("cwtctl status         # Show status of all jobs\n");
    out.push_str("cwtctl run <name>     # Run a job immediately\n");
    out.push_str("cwtctl pause <name>   # Pause a running job\n");
    out.push_str("cwtctl resume <name>  # Resume a paused job\n");
    out.push_str("cwtctl restart <name> # Restart a job\n");
    out.push_str("```\n");

    // Telegram section: show when a chat_id is resolvable and a bot token is available
    // (either explicitly in secret_keys or from global settings, which is auto-injected at runtime)
    let has_token = job.secret_keys.iter().any(|k| k == "TELEGRAM_BOT_TOKEN")
        || settings.telegram.as_ref().map_or(false, |tg| !tg.bot_token.is_empty());
    let chat_id = resolve_telegram_chat_id(job, settings);

    if has_token {
        if let Some(cid) = chat_id {
            out.push_str("\n## Telegram\n\n");
            out.push_str("The `TELEGRAM_BOT_TOKEN` env var is available. Send messages with:\n\n");
            out.push_str("```bash\n");
            out.push_str(&format!(
                "curl -s -X POST \"https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{{\"chat_id\": {}, \"text\": \"Your message\", \"parse_mode\": \"HTML\"}}'\n",
                cid
            ));
            out.push_str("```\n");
        }
    }

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

fn resolve_telegram_chat_id(job: &Job, settings: &AppSettings) -> Option<i64> {
    // Per-job chat_id takes priority
    if let Some(cid) = job.telegram_chat_id {
        return Some(cid);
    }
    // Fall back to first global chat_id
    if let Some(ref tg) = settings.telegram {
        return tg.chat_ids.first().copied();
    }
    None
}
