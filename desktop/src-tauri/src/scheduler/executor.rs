use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use tokio::process::Command;

use crate::config::jobs::{Job, JobStatus, JobType};
use crate::config::settings::AppSettings;
use crate::history::{HistoryStore, RunRecord};
use crate::relay::RelayHandle;
use crate::secrets::SecretsManager;
use crate::telegram::ActiveAgent;

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
    active_agents: &Arc<Mutex<HashMap<i64, ActiveAgent>>>,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
    params: &HashMap<String, String>,
) {
    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = Utc::now().to_rfc3339();

    // Mark as running (pane_id filled in later for tmux jobs)
    {
        let new_status = JobStatus::Running {
            run_id: run_id.clone(),
            started_at: started_at.clone(),
            pane_id: None,
            tmux_session: None,
        };
        let mut status = job_status.lock().unwrap();
        status.insert(job.name.clone(), new_status.clone());
        drop(status);
        crate::relay::push_status_update(relay, &job.name, &new_status);
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
            JobType::Claude => execute_claude_job(job, secrets, settings, params).await,
            JobType::Folder => execute_folder_job(job, secrets, settings, params).await,
        };

    // Get telegram config for notifications
    let telegram_config = {
        let s = settings.lock().unwrap();
        s.telegram.clone()
    };

    match result {
        Ok((exit_code, stdout, stderr, tmux_handle)) => {
            // If we got a tmux handle, update status with pane info and spawn the monitor
            if let Some(handle) = tmux_handle {
                {
                    let new_status = JobStatus::Running {
                        run_id: run_id.clone(),
                        started_at: started_at.clone(),
                        pane_id: Some(handle.pane_id.clone()),
                        tmux_session: Some(handle.tmux_session.clone()),
                    };
                    let mut status = job_status.lock().unwrap();
                    status.insert(job.name.clone(), new_status.clone());
                    drop(status);
                    crate::relay::push_status_update(relay, &job.name, &new_status);
                }
                // Register in active_agents so Telegram replies can be relayed
                {
                    let chat_id = job
                        .telegram_chat_id
                        .or_else(|| {
                            telegram_config
                                .as_ref()
                                .and_then(|c| c.chat_ids.first().copied())
                        });
                    if let Some(chat_id) = chat_id {
                        if let Ok(mut map) = active_agents.lock() {
                            log::info!(
                                "Registering active agent for chat_id={} pane={}",
                                chat_id,
                                handle.pane_id,
                            );
                            map.insert(
                                chat_id,
                                ActiveAgent {
                                    pane_id: handle.pane_id.clone(),
                                    tmux_session: handle.tmux_session.clone(),
                                    run_id: run_id.clone(),
                                    job_name: job.name.clone(),
                                },
                            );
                        }
                    }
                }

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
                    telegram_notify: job.telegram_notify.clone(),
                    history: Arc::clone(history),
                    job_status: Arc::clone(job_status),
                    notify_on_success,
                    relay: Arc::clone(relay),
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
                let mut status = job_status.lock().unwrap();
                status.insert(job.name.clone(), new_status.clone());
                drop(status);
                crate::relay::push_status_update(relay, &job.name, &new_status);
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
                send_job_notification(tg, job.telegram_chat_id, &job.name, exit_code, success, &stdout, &stderr)
                    .await;
            }
        }
        Err(e) => {
            let finished_at = Utc::now().to_rfc3339();
            log::error!("[{}] Job '{}' failed: {}", run_id, job.name, e);

            {
                let new_status = JobStatus::Failed {
                    last_run: finished_at.clone(),
                    exit_code: -1,
                };
                let mut status = job_status.lock().unwrap();
                status.insert(job.name.clone(), new_status.clone());
                drop(status);
                crate::relay::push_status_update(relay, &job.name, &new_status);
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
                send_job_notification(tg, job.telegram_chat_id, &job.name, Some(-1), false, "", &e).await;
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
    params: &HashMap<String, String>,
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

    let env_vars = collect_env_vars(job, secrets, settings);

    let window_name = project_window_name(job);
    let prompt_path = &job.path;

    // Read prompt file content so we can pass it inline (preserves @ references)
    let raw_prompt = std::fs::read_to_string(prompt_path)
        .map_err(|e| format!("Failed to read prompt file {}: {}", prompt_path, e))?;

    // Replace {key} placeholders with param values
    let raw_prompt = apply_params(raw_prompt, params);

    // Prepend skill @ references if any
    let prompt_content = if job.skill_paths.is_empty() {
        raw_prompt
    } else {
        let skill_refs = job
            .skill_paths
            .iter()
            .map(|p| format!("@{}", p))
            .collect::<Vec<_>>()
            .join(" ");
        format!("{}\n\n{}", skill_refs, raw_prompt)
    };

    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    // Create session if it doesn't exist
    if !tmux::session_exists(&tmux_session) {
        tmux::create_session(&tmux_session)?;
    }

    // Create window if it doesn't exist; track whether we just created it
    let window_just_created = if !tmux::window_exists(&tmux_session, &window_name) {
        tmux::create_window(&tmux_session, &window_name, &env_vars)?;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        true
    } else {
        false
    };

    let escaped_prompt = prompt_content.replace('\'', "'\\''");
    let send_cmd = format!(
        "cd {} && {} $'{}'",
        work_dir, claude_path, escaped_prompt
    );

    // If the window already existed, always split a new pane (other jobs may occupy it).
    // If we just created it, use the initial pane.
    let pane_id = if !window_just_created {
        let pane_id = tmux::split_pane(&tmux_session, &window_name, &env_vars)?;
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
    params: &HashMap<String, String>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
    use crate::cwt::CwtFolder;
    use crate::tmux;

    let folder_path = job
        .folder_path
        .as_ref()
        .ok_or("Folder job requires folder_path")?;

    let job_name = job.job_name.as_deref().unwrap_or("default");
    let cwt_root = std::path::Path::new(folder_path);

    // Lazy migration: move .cwt/job.md -> .cwt/default/job.md if needed
    crate::config::jobs::migrate_cwt_root(cwt_root);

    let folder = CwtFolder::from_path_with_job(cwt_root, job_name)?;

    if !folder.has_entry_point {
        return Err(format!(
            "No job.md entry point found in {}/{}",
            folder_path, job_name
        ));
    }

    let raw_prompt = folder.read_entry_point()?;

    // Replace {key} placeholders with param values
    let raw_prompt = apply_params(raw_prompt, params);

    // Build prompt: shared context, then per-job context, then skills, then per-job instructions
    let skill_refs = job
        .skill_paths
        .iter()
        .map(|p| format!("@{}", p))
        .collect::<Vec<_>>()
        .join(" ");
    let skill_part = if skill_refs.is_empty() {
        String::new()
    } else {
        format!(" {}", skill_refs)
    };
    let prompt_content = format!(
        "@.cwt/cwt.md @.cwt/{}/cwt.md @.cwt/{}/job.md{}\n\n{}",
        job_name, job_name, skill_part, raw_prompt
    );

    // Run from the project root (parent of .cwt), not the .cwt dir itself
    let project_root = cwt_root
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

    let env_vars = collect_env_vars(job, secrets, settings);

    let work_dir = project_root;
    let window_name = project_window_name(job);

    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    if !tmux::session_exists(&tmux_session) {
        tmux::create_session(&tmux_session)?;
    }

    let window_just_created = if !tmux::window_exists(&tmux_session, &window_name) {
        tmux::create_window(&tmux_session, &window_name, &env_vars)?;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        true
    } else {
        false
    };

    // Pass the prompt content directly to Claude via stdin-like heredoc
    let escaped_prompt = prompt_content.replace('\'', "'\\''");
    let send_cmd = format!(
        "cd {} && {} $'{}'",
        work_dir, claude_path, escaped_prompt
    );

    // If the window already existed, always split a new pane (other jobs may occupy it).
    // If we just created it, use the initial pane.
    let pane_id = if !window_just_created {
        let pane_id = tmux::split_pane(&tmux_session, &window_name, &env_vars)?;
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

/// Replace `{key}` placeholders in a prompt string with the provided param values.
fn apply_params(mut prompt: String, params: &HashMap<String, String>) -> String {
    for (key, value) in params {
        prompt = prompt.replace(&format!("{{{}}}", key), value);
    }
    prompt
}

/// Collect env vars from job's secret_keys as (key, value) pairs.
/// Also auto-injects TELEGRAM_BOT_TOKEN from global settings when the job
/// has a telegram_chat_id but doesn't explicitly list the token in secret_keys.
fn collect_env_vars(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
) -> Vec<(String, String)> {
    let sm = secrets.lock().unwrap();
    let mut vars = Vec::new();

    let is_agent = job.name == "agent";

    if is_agent {
        // Agent jobs get ALL secrets injected
        for key in sm.list_keys() {
            if let Some(value) = sm.get(&key) {
                vars.push((key, value.clone()));
            }
        }
    } else {
        for key in &job.secret_keys {
            if let Some(value) = sm.get(key) {
                vars.push((key.clone(), value.clone()));
            }
        }
    }

    // Auto-inject TELEGRAM_BOT_TOKEN from global settings when job has a chat_id
    if !vars.iter().any(|(k, _)| k == "TELEGRAM_BOT_TOKEN") {
        if job.telegram_chat_id.is_some() || is_agent {
            let s = settings.lock().unwrap();
            if let Some(ref tg) = s.telegram {
                if !tg.bot_token.is_empty() {
                    vars.push(("TELEGRAM_BOT_TOKEN".to_string(), tg.bot_token.clone()));
                }
            }
        }
    }

    vars
}

/// Extract the project prefix from a job's slug to use as the tmux window name.
/// For slug "myapp/deploy", returns "cwt-myapp".
/// Falls back to "cwt-{job.name}" if the slug has no '/'.
fn project_window_name(job: &Job) -> String {
    let project = match job.slug.split_once('/') {
        Some((prefix, _)) if !prefix.is_empty() => prefix,
        _ => &job.name,
    };
    format!("cwt-{}", project)
}

/// Send telegram notification, routing to per-job chat_id if set.
async fn send_job_notification(
    config: &crate::telegram::TelegramConfig,
    job_chat_id: Option<i64>,
    job_name: &str,
    exit_code: Option<i32>,
    success: bool,
    stdout: &str,
    stderr: &str,
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

    let mut text = format!(
        "<b>ClawTab</b>: Job <code>{}</code> {}{}",
        job_name, status, code_str
    );

    // Include stdout/stderr output for binary jobs (truncated to stay within Telegram limits)
    let output = if !stdout.trim().is_empty() && !stderr.trim().is_empty() {
        format!("{}\n{}", stdout.trim(), stderr.trim())
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        String::new()
    };

    if !output.is_empty() {
        // Escape HTML entities in output
        let escaped = output
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        // Truncate to keep within Telegram's 4096 char limit
        let max_output = 4096 - text.len() - 30; // leave room for <pre> tags and newlines
        let truncated = if escaped.len() > max_output {
            format!("{}...", &escaped[..max_output])
        } else {
            escaped
        };
        text.push_str(&format!("\n<pre>{}</pre>", truncated));
    }

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
