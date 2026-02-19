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
    if let Some(existing) = config.jobs.iter_mut().find(|j| j.name == job.name) {
        *existing = job;
    } else {
        config.jobs.push(job);
    }
    config.save()
}

#[tauri::command]
pub fn delete_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();
    config.jobs.retain(|j| j.name != name);
    config.save()
}

#[tauri::command]
pub fn toggle_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();
    if let Some(job) = config.jobs.iter_mut().find(|j| j.name == name) {
        job.enabled = !job.enabled;
    }
    config.save()
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
        "vscode" | "code" => {
            std::process::Command::new("code")
                .args([&folder_path, "--goto", &cwdt_md_str])
                .spawn()
                .map_err(|e| format!("Failed to open VS Code: {}", e))?;
        }
        _ => {
            // Default to nvim in terminal
            let cmd = format!("nvim {}", cwdt_md_str);
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
