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

fn lock_or_log<'a, T>(
    mutex: &'a Mutex<T>,
    name: &str,
) -> Option<std::sync::MutexGuard<'a, T>> {
    match mutex.lock() {
        Ok(guard) => Some(guard),
        Err(e) => {
            log::error!("Mutex '{}' poisoned: {}", name, e);
            None
        }
    }
}

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

    // Short initial poll to cancel any lingering long-poll from a previous instance
    // and to prime the offset with any pending updates.
    {
        let config = lock_or_log(&state.settings, "settings")
            .and_then(|s| s.telegram.clone());
        if let Some(c) = config {
            if c.agent_enabled && c.is_configured() {
                match get_updates(&c.bot_token, None, 0).await {
                    Ok(updates) => {
                        if let Some(last) = updates.last() {
                            offset = Some(last.update_id + 1);
                        }
                    }
                    Err(_) => {
                        // Retry once after a short delay (clears 409 conflict)
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        if let Ok(updates) = get_updates(&c.bot_token, None, 0).await {
                            if let Some(last) = updates.last() {
                                offset = Some(last.update_id + 1);
                            }
                        }
                    }
                }
            }
        }
    }

    loop {
        let config = lock_or_log(&state.settings, "settings")
            .and_then(|s| s.telegram.clone());

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

        log::debug!("Polling getUpdates (offset={:?})", offset);
        match get_updates(&config.bot_token, offset, 30).await {
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
                            if let Some(ref reply) = response {
                                log::info!("Sending reply: {}", &reply[..reply.len().min(100)]);
                            }
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
    let stale: Vec<i64> = match lock_or_log(active_agents, "active_agents") {
        Some(agents) => agents
            .iter()
            .filter(|(_, agent)| !tmux::is_pane_busy(&agent.tmux_session, &agent.pane_id))
            .map(|(&chat_id, _)| chat_id)
            .collect(),
        None => return,
    };

    for chat_id in stale {
        if let Some(mut agents) = lock_or_log(active_agents, "active_agents") {
            agents.remove(&chat_id);
        }
        let _ = super::send_message(&config.bot_token, chat_id, "Agent session ended.").await;
        log::info!("Cleaned up stale agent session for chat {}", chat_id);
    }
}

async fn get_updates(
    bot_token: &str,
    offset: Option<i64>,
    timeout_secs: u64,
) -> Result<Vec<Update>, String> {
    let client = reqwest::Client::new();
    let url = format!("https://api.telegram.org/bot{}/getUpdates", bot_token);

    let mut params = serde_json::json!({
        "timeout": timeout_secs,
        "allowed_updates": ["message"],
    });

    if let Some(off) = offset {
        params["offset"] = serde_json::json!(off);
    }

    let resp = client
        .post(&url)
        .json(&params)
        .timeout(std::time::Duration::from_secs(timeout_secs + 5))
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
        log::info!("Parsed Telegram command: {:?}", cmd);
        return Some(match cmd {
            AgentCommand::Help => commands::format_help(),
            AgentCommand::Jobs => {
                let jobs: Vec<Job> = lock_or_log(&state.jobs_config, "jobs_config")
                    .map(|c| c.jobs.clone())
                    .unwrap_or_default();
                commands::format_jobs(&jobs)
            }
            AgentCommand::Status => {
                let statuses = lock_or_log(&state.job_status, "job_status")
                    .map(|s| s.clone())
                    .unwrap_or_default();
                commands::format_status(&statuses)
            }
            AgentCommand::Run(name) => {
                let job = lock_or_log(&state.jobs_config, "jobs_config")
                    .and_then(|c| c.jobs.iter().find(|j| j.name == name).cloned());
                match job {
                    Some(job) => {
                        let secrets = Arc::clone(&state.secrets);
                        let history = Arc::clone(&state.history);
                        let settings = Arc::clone(&state.settings);
                        let job_status = Arc::clone(&state.job_status);
                        let active_agents = Arc::clone(&state.active_agents);
                        tokio::spawn(async move {
                            crate::scheduler::executor::execute_job(
                                &job, &secrets, &history, &settings, &job_status, "telegram",
                                &active_agents,
                            )
                            .await;
                        });
                        format!("Started job <code>{}</code>", name)
                    }
                    None => format!("Job not found: {}", name),
                }
            }
            AgentCommand::Pause(name) => {
                match lock_or_log(&state.job_status, "job_status") {
                    Some(mut status) => match status.get(&name) {
                        Some(JobStatus::Running { .. }) => {
                            status.insert(name.clone(), JobStatus::Paused);
                            format!("Paused job <code>{}</code>", name)
                        }
                        _ => format!("Job <code>{}</code> is not running", name),
                    },
                    None => "Internal error".to_string(),
                }
            }
            AgentCommand::Resume(name) => {
                match lock_or_log(&state.job_status, "job_status") {
                    Some(mut status) => match status.get(&name) {
                        Some(JobStatus::Paused) => {
                            status.insert(name.clone(), JobStatus::Idle);
                            format!("Resumed job <code>{}</code>", name)
                        }
                        _ => format!("Job <code>{}</code> is not paused", name),
                    },
                    None => "Internal error".to_string(),
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
        if let Some(agents) = lock_or_log(&state.active_agents, "active_agents") {
            if agents.contains_key(&chat_id) {
                return "An agent session is already active. Use /exit to end it first."
                    .to_string();
            }
        }
    }

    let (settings, jobs) = match (
        lock_or_log(&state.settings, "settings"),
        lock_or_log(&state.jobs_config, "jobs_config"),
    ) {
        (Some(s), Some(j)) => (s.clone(), j.jobs.clone()),
        _ => return "Internal error: failed to read config".to_string(),
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

    let active_agents = Arc::clone(&state.active_agents);
    let active_agents_for_exec = Arc::clone(&state.active_agents);

    tokio::spawn(async move {
        crate::scheduler::executor::execute_job(
            &job, &secrets, &history, &settings_arc, &job_status, "telegram",
            &active_agents_for_exec,
        )
        .await;
    });

    // Wait for execute_job to populate active_agents
    let mut found = false;
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if let Some(agents) = lock_or_log(&active_agents, "active_agents") {
            if agents.contains_key(&chat_id) {
                found = true;
                break;
            }
        }
    }

    if !found {
        log::warn!("Agent pane not found in active_agents after 6s wait");
        return "Agent started (could not track pane -- session may not support follow-up messages).".to_string();
    }

    // Check if privacy mode blocks follow-up messages in groups
    let bot_token = lock_or_log(&state.settings, "settings")
        .and_then(|s| s.telegram.as_ref().map(|t| t.bot_token.clone()));
    if let Some(ref token) = bot_token {
        if !super::can_read_group_messages(token).await {
            return concat!(
                "Agent session started, but the bot has Group Privacy mode enabled. ",
                "Follow-up messages in group chats will NOT be delivered to the agent.\n\n",
                "To fix: open @BotFather, send /mybots, select your bot, ",
                "go to Bot Settings > Group Privacy > Turn Off."
            ).to_string();
        }
    }

    "Agent session started. Send messages to interact, /exit to end.".to_string()
}

/// Handle /exit or /quit: kill the agent pane and clean up.
fn handle_exit_command(state: &AgentState, chat_id: i64) -> String {
    let agent = lock_or_log(&state.active_agents, "active_agents")
        .and_then(|mut agents| agents.remove(&chat_id));

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
    let agent = lock_or_log(&state.active_agents, "active_agents")?
        .get(&chat_id)
        .map(|a| (a.pane_id.clone(), a.tmux_session.clone()));

    let (pane_id, tmux_session) = match agent {
        Some(a) => a,
        None => return None, // No active session; ignore non-command text
    };

    // Check if the pane is still alive
    if !tmux::is_pane_busy(&tmux_session, &pane_id) {
        log::info!("Agent pane {} no longer busy, cleaning up", pane_id);
        if let Some(mut agents) = lock_or_log(&state.active_agents, "active_agents") {
            agents.remove(&chat_id);
        }
        return Some("Agent session has ended.".to_string());
    }

    log::info!(
        "Relaying message to agent pane {}: {}",
        pane_id,
        &text[..text.len().min(100)]
    );

    // Send the text to the pane as input (uses TUI-aware send for Claude Code)
    match tmux::send_keys_to_tui_pane(&pane_id, text) {
        Ok(()) => None, // Monitor will relay the response
        Err(e) => {
            log::error!("Failed to relay message to agent pane {}: {}", pane_id, e);
            if let Some(mut agents) = lock_or_log(&state.active_agents, "active_agents") {
                agents.remove(&chat_id);
            }
            Some("Failed to send message to agent. Session ended.".to_string())
        }
    }
}
