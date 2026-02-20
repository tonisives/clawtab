use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::config::jobs::{Job, JobStatus, JobsConfig};
use crate::config::settings::AppSettings;
use crate::history::HistoryStore;
use crate::secrets::SecretsManager;
use crate::tmux;

use super::commands::{self, AgentCommand};
use super::types::{TelegramResponse, Update};
use super::TelegramConfig;

const AGENT_WINDOW: &str = "cwt-agent";
const AGENT_POLL_INTERVAL_SECS: u64 = 8;
const AGENT_CAPTURE_LINES: u32 = 80;

pub struct AgentState {
    pub settings: Arc<Mutex<AppSettings>>,
    pub jobs_config: Arc<Mutex<JobsConfig>>,
    pub secrets: Arc<Mutex<SecretsManager>>,
    pub history: Arc<Mutex<HistoryStore>>,
    pub job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
}

pub async fn start_polling(state: AgentState) {
    let mut offset: Option<i64> = None;

    loop {
        let config = {
            let s = state.settings.lock().unwrap();
            s.telegram.clone()
        };

        let config = match config {
            Some(c) if c.agent_enabled && c.is_configured() => c,
            _ => {
                // Agent not enabled or not configured, check again later
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                continue;
            }
        };

        // Yield to setup poller so it can detect new chat IDs
        if super::is_setup_polling() {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            continue;
        }

        match get_updates(&config.bot_token, offset).await {
            Ok(updates) => {
                for update in updates {
                    offset = Some(update.update_id + 1);

                    if let Some(ref message) = update.message {
                        // Check allowlist
                        if !config.chat_ids.contains(&message.chat.id) {
                            log::debug!(
                                "Ignoring message from unauthorized chat {}",
                                message.chat.id
                            );
                            continue;
                        }

                        if let Some(ref text) = message.text {
                            let response =
                                handle_message(text, &config, &state, message.chat.id).await;
                            if let Some(reply) = response {
                                if let Err(e) = super::send_message(
                                    &config.bot_token,
                                    message.chat.id,
                                    &reply,
                                )
                                .await
                                {
                                    log::error!("Failed to send reply: {}", e);
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("Telegram polling error: {}", e);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    }
}

async fn get_updates(bot_token: &str, offset: Option<i64>) -> Result<Vec<Update>, String> {
    let client = reqwest::Client::new();
    let url = format!("https://api.telegram.org/bot{}/getUpdates", bot_token);

    let mut params = serde_json::json!({
        "timeout": 30,
        "allowed_updates": ["message"],
    });

    if let Some(off) = offset {
        params["offset"] = serde_json::json!(off);
    }

    let resp = client
        .post(&url)
        .json(&params)
        .timeout(std::time::Duration::from_secs(35))
        .send()
        .await
        .map_err(|e| format!("Telegram request failed: {}", e))?;

    let body: TelegramResponse<Vec<Update>> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !body.ok {
        return Err("Telegram API returned not ok".to_string());
    }

    Ok(body.result.unwrap_or_default())
}

async fn handle_message(
    text: &str,
    config: &TelegramConfig,
    state: &AgentState,
    chat_id: i64,
) -> Option<String> {
    let cmd = commands::parse_command(text)?;

    Some(match cmd {
        AgentCommand::Help => commands::format_help(),
        AgentCommand::Jobs => {
            let jobs: Vec<Job> = state.jobs_config.lock().unwrap().jobs.clone();
            commands::format_jobs(&jobs)
        }
        AgentCommand::Status => {
            let statuses = state.job_status.lock().unwrap().clone();
            commands::format_status(&statuses)
        }
        AgentCommand::Run(name) => {
            let job = {
                let config = state.jobs_config.lock().unwrap();
                config.jobs.iter().find(|j| j.name == name).cloned()
            };
            match job {
                Some(job) => {
                    let secrets = Arc::clone(&state.secrets);
                    let history = Arc::clone(&state.history);
                    let settings = Arc::clone(&state.settings);
                    let job_status = Arc::clone(&state.job_status);
                    tokio::spawn(async move {
                        crate::scheduler::executor::execute_job(
                            &job, &secrets, &history, &settings, &job_status, "telegram",
                        )
                        .await;
                    });
                    format!("Started job <code>{}</code>", name)
                }
                None => format!("Job not found: {}", name),
            }
        }
        AgentCommand::Pause(name) => {
            let mut status = state.job_status.lock().unwrap();
            match status.get(&name) {
                Some(JobStatus::Running { .. }) => {
                    status.insert(name.clone(), JobStatus::Paused);
                    format!("Paused job <code>{}</code>", name)
                }
                _ => format!("Job <code>{}</code> is not running", name),
            }
        }
        AgentCommand::Resume(name) => {
            let mut status = state.job_status.lock().unwrap();
            match status.get(&name) {
                Some(JobStatus::Paused) => {
                    status.insert(name.clone(), JobStatus::Idle);
                    format!("Resumed job <code>{}</code>", name)
                }
                _ => format!("Job <code>{}</code> is not paused", name),
            }
        }
        AgentCommand::Agent(prompt) => {
            handle_agent_command(&prompt, config, state, chat_id).await
        }
        AgentCommand::Unknown(msg) => msg,
    })
}

/// Handle /agent command: spawn a new tmux pane running claude, relay output to telegram.
async fn handle_agent_command(
    prompt: &str,
    config: &TelegramConfig,
    state: &AgentState,
    chat_id: i64,
) -> String {
    let (tmux_session, claude_path) = {
        let s = state.settings.lock().unwrap();
        (s.default_tmux_session.clone(), s.claude_path.clone())
    };

    if !tmux::is_available() {
        return "tmux is not available".to_string();
    }

    // Ensure session exists
    if !tmux::session_exists(&tmux_session) {
        if let Err(e) = tmux::create_session(&tmux_session) {
            return format!("Failed to create tmux session: {}", e);
        }
    }

    // Ensure agent window exists
    if !tmux::window_exists(&tmux_session, AGENT_WINDOW) {
        if let Err(e) = tmux::create_window(&tmux_session, AGENT_WINDOW, &[]) {
            return format!("Failed to create agent window: {}", e);
        }
        // Brief delay for window init
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // Split a new pane in the agent window
    let pane_id = match tmux::split_pane(&tmux_session, AGENT_WINDOW, &[]) {
        Ok(id) => id,
        Err(e) => return format!("Failed to split pane: {}", e),
    };

    // Brief delay for pane init
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // Build the claude command
    let agent_dir = crate::commands::jobs::agent_dir_path();
    let escaped_prompt = prompt.replace('\'', "'\\''");
    let cmd = format!(
        "cd {} && {} -p '{}'",
        agent_dir.display(),
        claude_path,
        escaped_prompt,
    );

    if let Err(e) = tmux::send_keys_to_pane(&tmux_session, &pane_id, &cmd) {
        return format!("Failed to send command to pane: {}", e);
    }

    // Spawn background task to poll output and relay to telegram
    let bot_token = config.bot_token.clone();
    let session = tmux_session.clone();
    let pane = pane_id.clone();

    tokio::spawn(async move {
        relay_agent_output(&bot_token, chat_id, &session, &pane).await;
    });

    format!("Agent started in pane <code>{}</code>", pane_id)
}

/// Poll tmux pane output and send new content to telegram chat.
async fn relay_agent_output(bot_token: &str, chat_id: i64, session: &str, pane_id: &str) {
    // Wait a bit for the process to start producing output
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    let mut last_content = String::new();
    let mut idle_ticks = 0u32;
    let max_idle_ticks = 5; // Stop after ~40s of no changes once process exits

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(AGENT_POLL_INTERVAL_SECS)).await;

        let capture = match tmux::capture_pane(session, pane_id, AGENT_CAPTURE_LINES) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("Failed to capture agent pane {}: {}", pane_id, e);
                // Pane probably closed
                break;
            }
        };

        // Trim trailing whitespace from each line and remove empty trailing lines
        let trimmed: String = capture
            .lines()
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();

        if trimmed != last_content && !trimmed.is_empty() {
            // Find new content by diffing
            let new_content = diff_content(&last_content, &trimmed);
            last_content = trimmed;
            idle_ticks = 0;

            if !new_content.is_empty() {
                let msg = format!("<pre>{}</pre>", html_escape(&new_content));
                if let Err(e) = super::send_message(bot_token, chat_id, &msg).await {
                    log::error!("Failed to relay agent output: {}", e);
                }
            }
        } else {
            // Check if process is still running
            let busy = tmux::is_pane_busy(session, pane_id);
            if !busy {
                idle_ticks += 1;
                if idle_ticks >= max_idle_ticks {
                    // Send final message
                    if let Err(e) =
                        super::send_message(bot_token, chat_id, "Agent finished.").await
                    {
                        log::error!("Failed to send agent completion: {}", e);
                    }
                    break;
                }
            }
        }
    }
}

/// Compute new lines that appear in `current` but not in `previous`.
fn diff_content(previous: &str, current: &str) -> String {
    if previous.is_empty() {
        return current.to_string();
    }

    // Find the common prefix by lines
    let prev_lines: Vec<&str> = previous.lines().collect();
    let curr_lines: Vec<&str> = current.lines().collect();

    // Find how many lines from the end of prev match the start of curr
    // (tmux capture is a sliding window, so old lines scroll off)
    let mut best_overlap = 0;
    let max_check = prev_lines.len().min(curr_lines.len());

    for overlap in 1..=max_check {
        let prev_tail = &prev_lines[prev_lines.len() - overlap..];
        let curr_head = &curr_lines[..overlap];
        if prev_tail == curr_head {
            best_overlap = overlap;
        }
    }

    if best_overlap > 0 {
        curr_lines[best_overlap..].join("\n")
    } else {
        // No overlap found, send everything (content scrolled past)
        current.to_string()
    }
}

/// Escape HTML special characters for telegram messages.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
