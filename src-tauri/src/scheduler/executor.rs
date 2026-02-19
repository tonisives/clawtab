use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use tokio::process::Command;

use crate::config::jobs::{Job, JobStatus, JobType};
use crate::config::settings::AppSettings;
use crate::history::{HistoryStore, RunRecord};
use crate::secrets::SecretsManager;

use super::monitor::{MonitorParams, TelegramStream};

/// Result from a tmux job: the tmux session and pane ID for monitoring.
struct TmuxHandle {
    tmux_session: String,
    pane_id: String,
}

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

    let result: Result<(Option<i32>, String, String, Option<TmuxHandle>), String> =
        match job.job_type {
            JobType::Binary => execute_binary_job(job, secrets, settings)
                .await
                .map(|(code, out, err)| (code, out, err, None)),
            JobType::Claude => execute_claude_job(job, secrets, settings).await,
            JobType::Folder => execute_folder_job(job, secrets, settings).await,
        };

    // Get telegram config for notifications
    let telegram_config = {
        let s = settings.lock().unwrap();
        s.telegram.clone()
    };

    match result {
        Ok((exit_code, stdout, stderr, tmux_handle)) => {
            // If we got a tmux handle, spawn the monitor -- it handles status/history/notifications
            if let Some(handle) = tmux_handle {
                let telegram = build_telegram_stream(&telegram_config, job.telegram_chat_id);
                let notify_on_success = telegram_config
                    .as_ref()
                    .map(|c| c.notify_on_success)
                    .unwrap_or(true);

                let params = MonitorParams {
                    tmux_session: handle.tmux_session,
                    pane_id: handle.pane_id,
                    run_id: run_id.clone(),
                    job_name: job.name.clone(),
                    slug: job.slug.clone(),
                    telegram,
                    history: Arc::clone(history),
                    job_status: Arc::clone(job_status),
                    notify_on_success,
                };
                tokio::spawn(super::monitor::monitor_pane(params));
                return;
            }

            // Non-tmux (binary) job: finalize immediately
            let finished_at = Utc::now().to_rfc3339();

            log::info!(
                "[{}] Job '{}' finished with exit code {:?}",
                run_id,
                job.name,
                exit_code
            );

            let success = matches!(exit_code, Some(0) | None);

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
                if let Err(e) =
                    h.update_finished(&run_id, &finished_at, exit_code, &stdout, &stderr)
                {
                    log::error!("Failed to update run record: {}", e);
                }
            }

            if let Some(ref tg) = telegram_config {
                send_job_notification(tg, job.telegram_chat_id, &job.name, exit_code, success)
                    .await;
            }
        }
        Err(e) => {
            let finished_at = Utc::now().to_rfc3339();
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

            if let Some(ref tg) = telegram_config {
                send_job_notification(tg, job.telegram_chat_id, &job.name, Some(-1), false).await;
            }
        }
    }
}

/// Build a TelegramStream for the monitor, using per-job chat_id or global chat_ids.
fn build_telegram_stream(
    config: &Option<crate::telegram::TelegramConfig>,
    job_chat_id: Option<i64>,
) -> Option<TelegramStream> {
    let config = config.as_ref()?;
    if !config.is_configured() {
        return None;
    }
    let chat_id = job_chat_id.or_else(|| config.chat_ids.first().copied())?;
    Some(TelegramStream {
        bot_token: config.bot_token.clone(),
        chat_id,
    })
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
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
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

    let export_prefix = build_export_prefix(job, secrets, settings);

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
        "{}cd {} && {} \"$(cat {})\"",
        export_prefix, work_dir, claude_path, prompt_path
    );

    // If window has an active process (e.g. Claude is still running), split a new pane
    let pane_id = if tmux::is_window_busy(&tmux_session, &window_name) {
        let pane_id = tmux::split_pane(&tmux_session, &window_name)?;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        tmux::send_keys_to_pane(&tmux_session, &pane_id, &send_cmd)?;
        pane_id
    } else {
        tmux::send_keys(&tmux_session, &window_name, &send_cmd)?;
        tmux::get_window_pane_id(&tmux_session, &window_name)?
    };

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

    let handle = TmuxHandle {
        tmux_session,
        pane_id,
    };
    Ok((Some(0), String::new(), String::new(), Some(handle)))
}

async fn execute_folder_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
    use crate::cwt::CwtFolder;
    use crate::tmux;

    let folder_path = job
        .folder_path
        .as_ref()
        .ok_or("Folder job requires folder_path")?;

    let folder = CwtFolder::from_path(std::path::Path::new(folder_path))?;

    if !folder.has_entry_point {
        return Err(format!(
            "No job.md entry point found in {}",
            folder_path
        ));
    }

    let raw_prompt = folder.read_entry_point()?;
    let prompt_content = format!("@.cwt/cwt.md @.cwt/job.md\n\n{}", raw_prompt);

    // Run from the project root (parent of .cwt), not the .cwt dir itself
    let project_root = std::path::Path::new(folder_path)
        .parent()
        .ok_or_else(|| format!("Cannot determine project root from {}", folder_path))?
        .to_string_lossy()
        .to_string();

    let (tmux_session, claude_path) = {
        let s = settings.lock().unwrap();
        let session = job
            .tmux_session
            .clone()
            .unwrap_or_else(|| s.default_tmux_session.clone());
        let cp = s.claude_path.clone();
        (session, cp)
    };

    let export_prefix = build_export_prefix(job, secrets, settings);

    let work_dir = project_root;
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
        "{}cd {} && {} $'{}'",
        export_prefix, work_dir, claude_path, escaped_prompt
    );

    // If window has an active process (e.g. Claude is still running), split a new pane
    let pane_id = if tmux::is_window_busy(&tmux_session, &window_name) {
        let pane_id = tmux::split_pane(&tmux_session, &window_name)?;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        tmux::send_keys_to_pane(&tmux_session, &pane_id, &send_cmd)?;
        pane_id
    } else {
        tmux::send_keys(&tmux_session, &window_name, &send_cmd)?;
        tmux::get_window_pane_id(&tmux_session, &window_name)?
    };

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

    let handle = TmuxHandle {
        tmux_session,
        pane_id,
    };
    Ok((Some(0), String::new(), String::new(), Some(handle)))
}

/// Build an `export K=V && ` prefix from job's secret_keys.
/// Also auto-injects TELEGRAM_BOT_TOKEN from global settings when the job
/// has a telegram_chat_id but doesn't explicitly list the token in secret_keys.
/// Returns empty string if nothing to export.
fn build_export_prefix(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
) -> String {
    let sm = secrets.lock().unwrap();
    let mut exports = Vec::new();

    for key in &job.secret_keys {
        if let Some(value) = sm.get(key) {
            let escaped = value.replace('\'', "'\\''");
            exports.push(format!("{}='{}'", key, escaped));
        }
    }

    // Auto-inject TELEGRAM_BOT_TOKEN from global settings when job has a chat_id
    if !job.secret_keys.iter().any(|k| k == "TELEGRAM_BOT_TOKEN") {
        if job.telegram_chat_id.is_some() {
            let s = settings.lock().unwrap();
            if let Some(ref tg) = s.telegram {
                if !tg.bot_token.is_empty() {
                    let escaped = tg.bot_token.replace('\'', "'\\''");
                    exports.push(format!("TELEGRAM_BOT_TOKEN='{}'", escaped));
                }
            }
        }
    }

    if exports.is_empty() {
        return String::new();
    }

    format!("export {} && ", exports.join(" "))
}

/// Send telegram notification, routing to per-job chat_id if set.
async fn send_job_notification(
    config: &crate::telegram::TelegramConfig,
    job_chat_id: Option<i64>,
    job_name: &str,
    exit_code: Option<i32>,
    success: bool,
) {
    if !config.is_configured() {
        return;
    }

    if success && !config.notify_on_success {
        return;
    }
    if !success && !config.notify_on_failure {
        return;
    }

    let status = if success { "completed" } else { "failed" };
    let code_str = exit_code
        .map(|c| format!(" (exit {})", c))
        .unwrap_or_default();

    let text = format!(
        "<b>ClawdTab</b>: Job <code>{}</code> {}{}",
        job_name, status, code_str
    );

    // Use per-job chat_id if set, otherwise fall back to global chat_ids
    let chat_ids: Vec<i64> = if let Some(cid) = job_chat_id {
        vec![cid]
    } else {
        config.chat_ids.clone()
    };

    for chat_id in chat_ids {
        if let Err(e) = crate::telegram::send_message(&config.bot_token, chat_id, &text).await {
            log::error!("Failed to send Telegram notification to {}: {}", chat_id, e);
        }
    }
}
