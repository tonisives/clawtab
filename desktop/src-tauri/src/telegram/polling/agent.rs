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
    if let Some(agents) = lock_or_log(&state.active_agents, "active_agents") {
        if agents.contains_key(&chat_id) {
            return "An agent session is already active. Use /exit to end it first.".to_string();
        }
    }

    let (settings, jobs) = match (
        lock_or_log(&state.settings, "settings"),
        lock_or_log(&state.jobs_config, "jobs_config"),
    ) {
        (Some(s), Some(j)) => (s.clone(), j.jobs.clone()),
        _ => return "Internal error: failed to read config".to_string(),
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
    let found = loop {
        let already_there = lock_or_log(&active_agents, "active_agents")
            .map(|a| a.contains_key(&chat_id))
            .unwrap_or(false);
        if already_there {
            break true;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break false;
        }
        match tokio::time::timeout(remaining, notified.as_mut()).await {
            Ok(()) => {
                notified.set(ctx.active_agents_notify.notified());
                notified.as_mut().enable();
            }
            Err(_) => break false,
        }
    };

    if !found {
        log::warn!("Agent pane not found in active_agents after 6s wait");
        return "Agent started (could not track pane -- session may not support follow-up messages).".to_string();
    }

    if let Some(token) = lock_or_log(&state.settings, "settings")
        .and_then(|s| s.telegram.as_ref().map(|t| t.bot_token.clone()))
    {
        if !telegram::can_read_group_messages(&token).await {
            return concat!(
                "Agent session started, but the bot has Group Privacy mode enabled. ",
                "Follow-up messages in group chats will NOT be delivered to the agent.\n\n",
                "To fix: open @BotFather, send /mybots, select your bot, ",
                "go to Bot Settings > Group Privacy > Turn Off."
            )
            .to_string();
        }
    }

    "Agent session started. Send messages to interact, /exit to end.".to_string()
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
