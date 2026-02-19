use std::sync::Arc;

use tauri::State;

use crate::config::jobs::{Job, JobStatus};
use crate::config::settings::AppSettings;
use crate::cwdt::CwdtFolder;
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
            &config.jobs,
        );
    }

    config.save_job(&job)?;

    // Refresh in-memory list
    *config = crate::config::jobs::JobsConfig::load();

    // Regenerate all cwdt.md context files (agent + per-job)
    let settings = state.settings.lock().unwrap().clone();
    let jobs = config.jobs.clone();
    drop(config);
    ensure_agent_dir(&settings, &jobs);
    regenerate_all_cwdt_contexts(&settings, &jobs);

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
) -> Result<(), String> {
    let preferred_editor = editor.unwrap_or_else(|| {
        let s = state.settings.lock().unwrap();
        s.preferred_editor.clone()
    });

    let target_file = file_name.as_deref().unwrap_or("job.md");
    let file_path = std::path::Path::new(&folder_path).join(target_file);

    // Create job.md with template if it doesn't exist (only for job.md)
    if target_file == "job.md" && !file_path.exists() {
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

    // For folder jobs, open the parent of .cwdt; otherwise use work_dir
    let folder = job
        .folder_path
        .as_ref()
        .and_then(|p| {
            let path = std::path::Path::new(p);
            // If path ends in .cwdt, go up to the project root
            if path.file_name().map(|n| n == ".cwdt").unwrap_or(false) {
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
pub fn init_cwdt_folder(folder_path: String) -> Result<CwdtFolder, String> {
    let path = std::path::Path::new(&folder_path);

    // Create directory if it doesn't exist
    if !path.exists() {
        std::fs::create_dir_all(path)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let job_md = path.join("job.md");
    if !job_md.exists() {
        let template = "# Job Directions\n\nDescribe what the bot should do here.\n";
        std::fs::write(&job_md, template)
            .map_err(|e| format!("Failed to create job.md: {}", e))?;
    }

    CwdtFolder::from_path(path)
}

#[tauri::command]
pub fn read_cwdt_entry(folder_path: String) -> Result<String, String> {
    let path = std::path::Path::new(&folder_path);
    let folder = CwdtFolder::from_path(path)?;
    if !folder.has_entry_point {
        return Ok(String::new());
    }
    folder.read_entry_point()
}

#[tauri::command]
pub fn derive_job_slug(state: State<AppState>, folder_path: String) -> String {
    let config = state.jobs_config.lock().unwrap();
    crate::config::jobs::derive_slug(&folder_path, &config.jobs)
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
    out.push_str("- Use cwdtctl to interact with ClawdTab jobs.\n");

    out.push_str("\n## Job Management CLI\n\n");
    out.push_str("`cwdtctl` is available for managing ClawdTab jobs:\n\n");
    out.push_str("```\n");
    out.push_str("cwdtctl ping           # Check if ClawdTab daemon is running\n");
    out.push_str("cwdtctl list           # List all configured jobs\n");
    out.push_str("cwdtctl status         # Show status of all jobs\n");
    out.push_str("cwdtctl run <name>     # Run a job immediately\n");
    out.push_str("cwdtctl pause <name>   # Pause a running job\n");
    out.push_str("cwdtctl resume <name>  # Resume a paused job\n");
    out.push_str("cwdtctl restart <name> # Restart a job\n");
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

/// Regenerate cwdt.md context file for every folder job's .cwdt directory.
pub fn regenerate_all_cwdt_contexts(settings: &AppSettings, jobs: &[Job]) {
    for job in jobs {
        if job.job_type != crate::config::jobs::JobType::Folder {
            continue;
        }
        if let Some(ref folder_path) = job.folder_path {
            let content = generate_cwdt_context(job, settings);
            let path = std::path::Path::new(folder_path).join("cwdt.md");
            if let Err(e) = std::fs::write(&path, content) {
                log::warn!("Failed to write cwdt.md for '{}': {}", job.name, e);
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

fn generate_cwdt_context(job: &Job, settings: &AppSettings) -> String {
    let mut out = String::new();

    out.push_str("<!-- Auto-generated by ClawdTab. Regenerated on settings/jobs change. -->\n");
    out.push_str("# ClawdTab Environment\n\n");
    out.push_str("You are running as an automated Claude Code job.\n");
    out.push_str(&format!("Job name: `{}`\n", job.name));

    out.push_str("\n## Rules\n\n");
    out.push_str("- Only edit and look for files in the current directory.\n");
    out.push_str("- The job directions are in `.cwdt/job.md`.\n");

    out.push_str("\n## Job Management CLI\n\n");
    out.push_str("`cwdtctl` is available for managing ClawdTab jobs:\n\n");
    out.push_str("```\n");
    out.push_str("cwdtctl ping           # Check if ClawdTab daemon is running\n");
    out.push_str("cwdtctl list           # List all configured jobs\n");
    out.push_str("cwdtctl status         # Show status of all jobs\n");
    out.push_str("cwdtctl run <name>     # Run a job immediately\n");
    out.push_str("cwdtctl pause <name>   # Pause a running job\n");
    out.push_str("cwdtctl resume <name>  # Resume a paused job\n");
    out.push_str("cwdtctl restart <name> # Restart a job\n");
    out.push_str("```\n");

    // Telegram section
    let has_token_secret = job.secret_keys.iter().any(|k| k == "TELEGRAM_BOT_TOKEN");
    let chat_id = resolve_telegram_chat_id(job, settings);

    if has_token_secret {
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
    } else if chat_id.is_some() {
        // Telegram is configured for this job but TELEGRAM_BOT_TOKEN not in secrets
        out.push_str("\n## Telegram\n\n");
        out.push_str("Telegram notifications are configured for this job, but `TELEGRAM_BOT_TOKEN` is not in this job's secrets.\n");
        out.push_str("Add `TELEGRAM_BOT_TOKEN` to this job's secrets to enable direct Telegram messaging from within the job.\n");
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
