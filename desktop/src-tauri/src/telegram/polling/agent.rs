//! Handlers for the interactive /agent, /exit, and free-text relay flows.

use std::sync::Arc;

use crate::telegram::{self, TelegramConfig};
use crate::tmux;

use super::{lock_or_log, AgentState};

/// /agent <prompt>: build a synthetic agent Job, spawn it, then wait for the
/// executor to publish into active_agents so the chat can use follow-up
/// messages.
pub(super) async fn handle_agent_command(
    prompt: &str,
    _config: &TelegramConfig,
    state: &AgentState,
    chat_id: i64,
) -> String {
    if agent_already_active(state, chat_id) {
        return "An agent session is already active. Use /exit to end it first.".to_string();
    }

    let Some((settings, jobs)) = read_settings_and_jobs(state) else {
        return "Internal error: failed to read config".to_string();
    };

    let job = match crate::agent::build_agent_job(
        prompt,
        Some(chat_id),
        &settings,
        &jobs,
        None,
        None,
        None,
    ) {
        Ok(j) => j,
        Err(e) => return format!("Failed to build agent job: {}", e),
    };

    let found = spawn_and_wait_for_pane(state, job, chat_id).await;
    if !found {
        log::warn!("Agent pane not found in active_agents after 6s wait");
        return "Agent started (could not track pane - session may not support follow-up messages).".to_string();
    }

    if group_privacy_blocks_followups(state).await {
        return concat!(
            "Agent session started, but the bot has Group Privacy mode enabled. ",
            "Follow-up messages in group chats will NOT be delivered to the agent.\n\n",
            "To fix: open @BotFather, send /mybots, select your bot, ",
            "go to Bot Settings > Group Privacy > Turn Off."
        )
        .to_string();
    }

    "Agent session started. Send messages to interact, /exit to end.".to_string()
}

fn agent_already_active(state: &AgentState, chat_id: i64) -> bool {
    lock_or_log(&state.active_agents, "active_agents")
        .is_some_and(|agents| agents.contains_key(&chat_id))
}

fn read_settings_and_jobs(state: &AgentState) -> Option<(crate::config::settings::AppSettings, Vec<crate::config::jobs::Job>)> {
    let settings = lock_or_log(&state.settings, "settings")?;
    let jobs_config = lock_or_log(&state.jobs_config, "jobs_config")?;
    Some((settings.clone(), jobs_config.jobs.clone()))
}

async fn spawn_and_wait_for_pane(
    state: &AgentState,
    job: crate::config::jobs::Job,
    chat_id: i64,
) -> bool {
    let active_agents = Arc::clone(&state.active_agents);
    let ctx = state.ctx.clone();

    // Register a wait on active_agents_notify BEFORE spawning the executor so we
    // don't miss the signal if the insert happens immediately.
    let notified = ctx.active_agents_notify.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();

    tokio::spawn({
        let ctx = ctx.clone();
        async move {
            crate::scheduler::executor::execute_job(
                &job,
                &ctx,
                "telegram",
                &std::collections::HashMap::new(),
                crate::scheduler::executor::ExecuteOpts::default(),
            )
            .await;
        }
    });

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(6);
    loop {
        let already_there = lock_or_log(&active_agents, "active_agents")
            .is_some_and(|a| a.contains_key(&chat_id));
        if already_there {
            return true;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match tokio::time::timeout(remaining, notified.as_mut()).await {
            Ok(()) => {
                notified.set(ctx.active_agents_notify.notified());
                notified.as_mut().enable();
            }
            Err(_) => return false,
        }
    }
}

async fn group_privacy_blocks_followups(state: &AgentState) -> bool {
    let Some(token) = lock_or_log(&state.settings, "settings")
        .and_then(|s| s.telegram.as_ref().map(|t| t.bot_token.clone()))
    else {
        return false;
    };
    !telegram::can_read_group_messages(&token).await
}

/// /exit or /quit: gracefully tell Claude Code to exit, then kill the pane.
pub(super) async fn handle_exit_command(state: &AgentState, chat_id: i64) -> String {
    let agent = lock_or_log(&state.active_agents, "active_agents")
        .and_then(|mut agents| agents.remove(&chat_id));

    let Some(agent) = agent else {
        return "No active agent session.".to_string();
    };

    if let Err(e) = tmux::send_keys_to_tui_pane(&agent.pane_id, "/exit") {
        log::warn!(
            "Failed to send /exit to agent pane {}: {}",
            agent.pane_id,
            e
        );
    }
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    if let Err(e) = tmux::kill_pane(&agent.pane_id) {
        log::warn!("Failed to kill agent pane {}: {}", agent.pane_id, e);
    }
    "Session ended.".to_string()
}

/// Free-text message: forward it as keystrokes to the agent's tmux pane.
/// Returns None on success (monitor will relay Claude's response), or an
/// error message on failure.
pub(super) async fn relay_to_agent(
    text: &str,
    state: &AgentState,
    chat_id: i64,
) -> Option<String> {
    let agent = lock_or_log(&state.active_agents, "active_agents")?
        .get(&chat_id)
        .map(|a| (a.pane_id.clone(), a.tmux_session.clone()));

    let (pane_id, tmux_session) = agent?;

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

    match tmux::send_keys_to_tui_pane(&pane_id, text) {
        Ok(()) => None,
        Err(e) => {
            log::error!("Failed to relay message to agent pane {}: {}", pane_id, e);
            if let Some(mut agents) = lock_or_log(&state.active_agents, "active_agents") {
                agents.remove(&chat_id);
            }
            Some("Failed to send message to agent. Session ended.".to_string())
        }
    }
}
