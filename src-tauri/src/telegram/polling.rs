use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::config::jobs::{Job, JobStatus, JobsConfig};
use crate::config::settings::AppSettings;
use crate::history::HistoryStore;
use crate::secrets::SecretsManager;
use crate::tmux;

use super::commands::{self, AgentCommand};
use super::types::{TelegramResponse, Update};
use super::{ActiveAgent, TelegramConfig};

pub struct AgentState {
    pub settings: Arc<Mutex<AppSettings>>,
    pub jobs_config: Arc<Mutex<JobsConfig>>,
    pub secrets: Arc<Mutex<SecretsManager>>,
    pub history: Arc<Mutex<HistoryStore>>,
    pub job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    pub active_agents: Arc<Mutex<HashMap<i64, ActiveAgent>>>,
}

pub async fn start_polling(state: AgentState) {
    let mut offset: Option<i64> = None;

    log::info!("Telegram agent polling started");

    loop {
        let config = {
            let s = state.settings.lock().unwrap();
            s.telegram.clone()
        };

        let config = match config {
            Some(c) if c.agent_enabled && c.is_configured() => c,
            _ => {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                continue;
            }
        };

        // Yield to setup poller so it can detect new chat IDs
        if super::is_setup_polling() {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            continue;
        }

        // Clean up stale active_agents whose panes no longer exist
        cleanup_stale_agents(&state.active_agents, &config).await;

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
                            log::info!(
                                "Telegram message from {}: {}",
                                message.chat.id,
                                &text[..text.len().min(100)]
                            );
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

/// Remove active_agents entries whose tmux panes no longer exist.
/// Sends an "Agent session ended" notification for each stale entry.
async fn cleanup_stale_agents(
    active_agents: &Arc<Mutex<HashMap<i64, ActiveAgent>>>,
    config: &TelegramConfig,
) {
    let stale: Vec<i64> = {
        let agents = active_agents.lock().unwrap();
        agents
            .iter()
            .filter(|(_, agent)| !tmux::is_pane_busy(&agent.tmux_session, &agent.pane_id))
            .map(|(&chat_id, _)| chat_id)
            .collect()
    };

    for chat_id in stale {
        {
            active_agents.lock().unwrap().remove(&chat_id);
        }
        let _ = super::send_message(
            &config.bot_token,
            chat_id,
            "Agent session ended.",
        )
        .await;
        log::info!("Cleaned up stale agent session for chat {}", chat_id);
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
        let desc = body.description.unwrap_or_else(|| "unknown error".to_string());
        return Err(format!("Telegram API error: {}", desc));
    }

    Ok(body.result.unwrap_or_default())
}

async fn handle_message(
    text: &str,
    config: &TelegramConfig,
    state: &AgentState,
    chat_id: i64,
) -> Option<String> {
    // Try parsing as a command first
    if let Some(cmd) = commands::parse_command(text) {
        return Some(match cmd {
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
            AgentCommand::AgentExit => handle_exit_command(state, chat_id),
            AgentCommand::Unknown(msg) => msg,
        });
    }

    // Not a command -- check if there's an active agent session to relay to
    relay_to_agent(text, state, chat_id).await
}

/// Handle /agent command: build a synthetic agent Job and run it through execute_job.
/// Waits briefly for the job_status to populate with pane_id, then stores ActiveAgent.
async fn handle_agent_command(
    prompt: &str,
    _config: &TelegramConfig,
    state: &AgentState,
    chat_id: i64,
) -> String {
    // Reject if there's already an active session for this chat
    {
        let agents = state.active_agents.lock().unwrap();
        if agents.contains_key(&chat_id) {
            return "An agent session is already active. Use /exit to end it first.".to_string();
        }
    }

    let (settings, jobs) = {
        let s = state.settings.lock().unwrap();
        let j = state.jobs_config.lock().unwrap();
        (s.clone(), j.jobs.clone())
    };

    let job = match crate::commands::jobs::build_agent_job(prompt, Some(chat_id), &settings, &jobs)
    {
        Ok(j) => j,
        Err(e) => return format!("Failed to build agent job: {}", e),
    };

    let secrets = Arc::clone(&state.secrets);
    let history = Arc::clone(&state.history);
    let settings_arc = Arc::clone(&state.settings);
    let job_status = Arc::clone(&state.job_status);

    tokio::spawn(async move {
        crate::scheduler::executor::execute_job(
            &job, &secrets, &history, &settings_arc, &job_status, "telegram",
        )
        .await;
    });

    // Wait for the executor to populate the pane_id in job_status
    let active_agents = Arc::clone(&state.active_agents);
    let job_status = Arc::clone(&state.job_status);
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let status = job_status.lock().unwrap();
        if let Some(JobStatus::Running {
            pane_id: Some(ref pane_id),
            tmux_session: Some(ref session),
            run_id: ref rid,
            ..
        }) = status.get("agent")
        {
            let agent = ActiveAgent {
                pane_id: pane_id.clone(),
                tmux_session: session.clone(),
                run_id: rid.clone(),
            };
            active_agents.lock().unwrap().insert(chat_id, agent);
            return "Agent session started. Send messages to interact, /exit to end.".to_string();
        }
    }

    "Agent started (could not track pane -- session may not support follow-up messages).".to_string()
}

/// Handle /exit or /quit: kill the agent pane and clean up.
fn handle_exit_command(state: &AgentState, chat_id: i64) -> String {
    let agent = {
        let mut agents = state.active_agents.lock().unwrap();
        agents.remove(&chat_id)
    };

    match agent {
        Some(agent) => {
            if let Err(e) = tmux::kill_pane(&agent.pane_id) {
                log::warn!("Failed to kill agent pane {}: {}", agent.pane_id, e);
            }
            "Agent session ended.".to_string()
        }
        None => "No active agent session.".to_string(),
    }
}

/// Relay a non-command message to the active agent's tmux pane.
/// Returns None if the relay succeeds (the monitor will relay Claude's response).
/// Returns Some(error_message) if the pane is gone or there's no active session.
async fn relay_to_agent(
    text: &str,
    state: &AgentState,
    chat_id: i64,
) -> Option<String> {
    let agent = {
        let agents = state.active_agents.lock().unwrap();
        agents.get(&chat_id).map(|a| (a.pane_id.clone(), a.tmux_session.clone()))
    };

    let (pane_id, tmux_session) = match agent {
        Some(a) => a,
        None => return None, // No active session; ignore non-command text
    };

    // Check if the pane is still alive
    if !tmux::is_pane_busy(&tmux_session, &pane_id) {
        log::info!("Agent pane {} no longer busy, cleaning up", pane_id);
        state.active_agents.lock().unwrap().remove(&chat_id);
        return Some("Agent session has ended.".to_string());
    }

    log::info!("Relaying message to agent pane {}: {}", pane_id, &text[..text.len().min(100)]);

    // Send the text to the pane as input
    match tmux::send_keys_to_pane(&tmux_session, &pane_id, text) {
        Ok(()) => None, // Monitor will relay the response
        Err(e) => {
            log::error!("Failed to relay message to agent pane {}: {}", pane_id, e);
            state.active_agents.lock().unwrap().remove(&chat_id);
            Some("Failed to send message to agent. Session ended.".to_string())
        }
    }
}
