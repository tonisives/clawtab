use std::sync::Arc;

use tauri::State;

use crate::config::jobs::{Job, JobStatus};
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
) -> Result<(), String> {
    let preferred_editor = editor.unwrap_or_else(|| {
        let s = state.settings.lock().unwrap();
        s.preferred_editor.clone()
    });

    let cwdt_md = std::path::Path::new(&folder_path).join("cwdt.md");

    // Create cwdt.md with template if it doesn't exist
    if !cwdt_md.exists() {
        let template = "# Job Directions\n\nDescribe what the bot should do here.\n";
        std::fs::write(&cwdt_md, template)
            .map_err(|e| format!("Failed to create cwdt.md: {}", e))?;
    }

    let cwdt_md_str = cwdt_md.display().to_string();

    match preferred_editor.as_str() {
        "code" => {
            std::process::Command::new("code")
                .args([&folder_path, "--goto", &cwdt_md_str])
                .spawn()
                .map_err(|e| format!("Failed to open VS Code: {}", e))?;
        }
        "codium" => {
            std::process::Command::new("codium")
                .args([&folder_path, "--goto", &cwdt_md_str])
                .spawn()
                .map_err(|e| format!("Failed to open VSCodium: {}", e))?;
        }
        "zed" => {
            std::process::Command::new("zed")
                .arg(&cwdt_md_str)
                .spawn()
                .map_err(|e| format!("Failed to open Zed: {}", e))?;
        }
        "subl" => {
            std::process::Command::new("subl")
                .arg(&cwdt_md_str)
                .spawn()
                .map_err(|e| format!("Failed to open Sublime Text: {}", e))?;
        }
        // Terminal-based editors: nvim, vim, hx, emacs
        editor => {
            let cmd = format!("{} {}", editor, cwdt_md_str);
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

    let cwdt_md = path.join("cwdt.md");
    if !cwdt_md.exists() {
        let template = "# Job Directions\n\nDescribe what the bot should do here.\n";
        std::fs::write(&cwdt_md, template)
            .map_err(|e| format!("Failed to create cwdt.md: {}", e))?;
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
