use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use tokio::process::Command;

use crate::config::jobs::{Job, JobStatus, JobType};
use crate::config::settings::AppSettings;
use crate::history::{HistoryStore, RunRecord};
use crate::secrets::SecretsManager;

pub async fn execute_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    history: &Arc<Mutex<HistoryStore>>,
    settings: &Arc<Mutex<AppSettings>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    trigger: &str,
) {
    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = Utc::now().to_rfc3339();

    // Mark as running
    {
        let mut status = job_status.lock().unwrap();
        status.insert(
            job.name.clone(),
            JobStatus::Running {
                run_id: run_id.clone(),
                started_at: started_at.clone(),
            },
        );
    }

    let record = RunRecord {
        id: run_id.clone(),
        job_name: job.name.clone(),
        started_at: started_at.clone(),
        finished_at: None,
        exit_code: None,
        trigger: trigger.to_string(),
        stdout: String::new(),
        stderr: String::new(),
    };

    {
        let h = history.lock().unwrap();
        if let Err(e) = h.insert(&record) {
            log::error!("Failed to insert run record: {}", e);
        }
    }

    log::info!("[{}] Starting job '{}' ({})", run_id, job.name, trigger);

    let result = match job.job_type {
        JobType::Binary => execute_binary_job(job, secrets, settings).await,
        JobType::Claude => execute_claude_job(job, settings).await,
        JobType::Folder => execute_folder_job(job, settings).await,
    };

    let finished_at = Utc::now().to_rfc3339();

    // Get telegram config for notifications
    let telegram_config = {
        let s = settings.lock().unwrap();
        s.telegram.clone()
    };

    match result {
        Ok((exit_code, stdout, stderr)) => {
            log::info!(
                "[{}] Job '{}' finished with exit code {:?}",
                run_id,
                job.name,
                exit_code
            );

            let success = matches!(exit_code, Some(0) | None);

            // Update status based on exit code
            {
                let mut status = job_status.lock().unwrap();
                let new_status = if success {
                    JobStatus::Success {
                        last_run: finished_at.clone(),
                    }
                } else {
                    JobStatus::Failed {
                        last_run: finished_at.clone(),
                        exit_code: exit_code.unwrap_or(-1),
                    }
                };
                status.insert(job.name.clone(), new_status);
            }

            {
                let h = history.lock().unwrap();
                if let Err(e) = h.update_finished(&run_id, &finished_at, exit_code, &stdout, &stderr) {
                    log::error!("Failed to update run record: {}", e);
                }
            }

            // Send telegram notification (after dropping MutexGuard)
            if let Some(ref tg) = telegram_config {
                crate::telegram::notify_job_result(tg, &job.name, exit_code, success).await;
            }
        }
        Err(e) => {
            log::error!("[{}] Job '{}' failed: {}", run_id, job.name, e);

            {
                let mut status = job_status.lock().unwrap();
                status.insert(
                    job.name.clone(),
                    JobStatus::Failed {
                        last_run: finished_at.clone(),
                        exit_code: -1,
                    },
                );
            }

            {
                let h = history.lock().unwrap();
                if let Err(e2) =
                    h.update_finished(&run_id, &finished_at, Some(-1), "", &e.to_string())
                {
                    log::error!("Failed to update run record: {}", e2);
                }
            }

            // Send telegram notification for failure (after dropping MutexGuard)
            if let Some(ref tg) = telegram_config {
                crate::telegram::notify_job_result(tg, &job.name, Some(-1), false).await;
            }
        }
    }
}

async fn execute_binary_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
) -> Result<(Option<i32>, String, String), String> {
    let work_dir = job.work_dir.clone().unwrap_or_else(|| {
        let s = settings.lock().unwrap();
        s.default_work_dir.clone()
    });

    let mut cmd = Command::new(&job.path);
    cmd.args(&job.args);
    cmd.env_clear();

    // Set PATH and HOME from current process
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }

    // Inject secrets
    {
        let sm = secrets.lock().unwrap();
        for key in &job.secret_keys {
            if let Some(value) = sm.get(key) {
                cmd.env(key, value);
            }
        }
    }

    // Static env vars
    for (k, v) in &job.env {
        cmd.env(k, v);
    }

    cmd.current_dir(&work_dir);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to wait for process: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code();

    Ok((exit_code, stdout, stderr))
}

async fn execute_claude_job(
    job: &Job,
    settings: &Arc<Mutex<AppSettings>>,
) -> Result<(Option<i32>, String, String), String> {
    use crate::tmux;

    let (tmux_session, work_dir, claude_path) = {
        let s = settings.lock().unwrap();
        let session = job
            .tmux_session
            .clone()
            .unwrap_or_else(|| s.default_tmux_session.clone());
        let wd = job
            .work_dir
            .clone()
            .unwrap_or_else(|| s.default_work_dir.clone());
        let cp = s.claude_path.clone();
        (session, wd, cp)
    };

    let window_name = format!("cm-{}", job.name);
    let prompt_path = &job.path;

    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    // Create session if it doesn't exist
    if !tmux::session_exists(&tmux_session) {
        tmux::create_session(&tmux_session)?;
    }

    // Create window if it doesn't exist
    if !tmux::window_exists(&tmux_session, &window_name) {
        tmux::create_window(&tmux_session, &window_name)?;
        // Wait for window to be ready
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    let send_cmd = format!(
        "cd {} && {} \"$(cat {})\"",
        work_dir, claude_path, prompt_path
    );

    tmux::send_keys(&tmux_session, &window_name, &send_cmd)?;

    // Move to aerospace workspace if configured
    if let Some(ref workspace) = job.aerospace_workspace {
        if crate::aerospace::is_available() {
            // Focus the tmux window first, then move it
            let _ = tmux::focus_window(&tmux_session, &window_name);
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            if let Err(e) = crate::aerospace::move_window_to_workspace(workspace) {
                log::warn!("Failed to move window to aerospace workspace '{}': {}", workspace, e);
            }
        }
    }

    Ok((Some(0), String::new(), String::new()))
}

async fn execute_folder_job(
    job: &Job,
    settings: &Arc<Mutex<AppSettings>>,
) -> Result<(Option<i32>, String, String), String> {
    use crate::cwdt::CwdtFolder;
    use crate::tmux;

    let folder_path = job
        .folder_path
        .as_ref()
        .ok_or("Folder job requires folder_path")?;

    let folder = CwdtFolder::from_path(std::path::Path::new(folder_path))?;

    if !folder.has_entry_point {
        return Err(format!(
            "No cwdt.md entry point found in {}",
            folder_path
        ));
    }

    let prompt_content = folder.read_entry_point()?;

    let (tmux_session, claude_path) = {
        let s = settings.lock().unwrap();
        let session = job
            .tmux_session
            .clone()
            .unwrap_or_else(|| s.default_tmux_session.clone());
        let cp = s.claude_path.clone();
        (session, cp)
    };

    // Use the folder itself as the working directory
    let work_dir = folder_path.clone();
    let window_name = format!("cm-{}", job.name);

    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    if !tmux::session_exists(&tmux_session) {
        tmux::create_session(&tmux_session)?;
    }

    if !tmux::window_exists(&tmux_session, &window_name) {
        tmux::create_window(&tmux_session, &window_name)?;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // Pass the prompt content directly to Claude via stdin-like heredoc
    let escaped_prompt = prompt_content.replace('\'', "'\\''");
    let send_cmd = format!(
        "cd {} && {} $'{}'",
        work_dir, claude_path, escaped_prompt
    );

    tmux::send_keys(&tmux_session, &window_name, &send_cmd)?;

    // Move to aerospace workspace if configured
    if let Some(ref workspace) = job.aerospace_workspace {
        if crate::aerospace::is_available() {
            let _ = tmux::focus_window(&tmux_session, &window_name);
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            if let Err(e) = crate::aerospace::move_window_to_workspace(workspace) {
                log::warn!(
                    "Failed to move window to aerospace workspace '{}': {}",
                    workspace,
                    e
                );
            }
        }
    }

    Ok((Some(0), String::new(), String::new()))
}
