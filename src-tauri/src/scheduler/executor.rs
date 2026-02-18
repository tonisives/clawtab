use std::sync::{Arc, Mutex};

use chrono::Utc;
use tokio::process::Command;

use crate::config::jobs::{Job, JobType};
use crate::config::settings::AppSettings;
use crate::history::{HistoryStore, RunRecord};
use crate::secrets::SecretsManager;

pub async fn execute_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    history: &Arc<Mutex<HistoryStore>>,
    settings: &Arc<Mutex<AppSettings>>,
    trigger: &str,
) {
    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = Utc::now().to_rfc3339();

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
    };

    let finished_at = Utc::now().to_rfc3339();

    match result {
        Ok((exit_code, stdout, stderr)) => {
            log::info!(
                "[{}] Job '{}' finished with exit code {:?}",
                run_id,
                job.name,
                exit_code
            );
            let h = history.lock().unwrap();
            if let Err(e) = h.update_finished(&run_id, &finished_at, exit_code, &stdout, &stderr) {
                log::error!("Failed to update run record: {}", e);
            }
        }
        Err(e) => {
            log::error!("[{}] Job '{}' failed: {}", run_id, job.name, e);
            let h = history.lock().unwrap();
            if let Err(e2) =
                h.update_finished(&run_id, &finished_at, Some(-1), "", &e.to_string())
            {
                log::error!("Failed to update run record: {}", e2);
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

    // Check if tmux session exists
    let session_check = Command::new("tmux")
        .args(["has-session", "-t", &tmux_session])
        .output()
        .await
        .map_err(|e| format!("Failed to check tmux session: {}", e))?;

    if !session_check.status.success() {
        return Err(format!(
            "tmux session '{}' not found. Create it first: tmux new-session -d -s {}",
            tmux_session, tmux_session
        ));
    }

    // Check if window already exists
    let window_check = Command::new("tmux")
        .args([
            "list-windows",
            "-t",
            &tmux_session,
            "-F",
            "#W",
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to list tmux windows: {}", e))?;

    let windows_output = String::from_utf8_lossy(&window_check.stdout);
    let window_exists = windows_output
        .lines()
        .any(|w| w.trim() == window_name);

    let send_cmd = format!(
        "cd {} && {} \"$(cat {})\"",
        work_dir, claude_path, prompt_path
    );

    if window_exists {
        // Send to existing window
        let output = Command::new("tmux")
            .args([
                "send-keys",
                "-t",
                &format!("{}:{}", tmux_session, window_name),
                &send_cmd,
                "Enter",
            ])
            .output()
            .await
            .map_err(|e| format!("Failed to send keys to tmux: {}", e))?;

        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Ok((output.status.code(), String::new(), stderr))
    } else {
        // Create new window
        let new_window = Command::new("tmux")
            .args([
                "new-window",
                "-t",
                &tmux_session,
                "-n",
                &window_name,
            ])
            .output()
            .await
            .map_err(|e| format!("Failed to create tmux window: {}", e))?;

        if !new_window.status.success() {
            let stderr = String::from_utf8_lossy(&new_window.stderr);
            return Err(format!("Failed to create tmux window: {}", stderr));
        }

        // Wait for window to be ready
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let output = Command::new("tmux")
            .args([
                "send-keys",
                "-t",
                &format!("{}:{}", tmux_session, window_name),
                &send_cmd,
                "Enter",
            ])
            .output()
            .await
            .map_err(|e| format!("Failed to send keys to tmux: {}", e))?;

        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Ok((output.status.code(), String::new(), stderr))
    }
}
