//! Telegram bot poller.
//!
//! `start_polling` runs the long-poll loop. Each update is fanned out to
//! `dispatch::handle_update`, which routes commands to `agent` (for /agent and
//! /exit) and `dispatch::handle_message` (for everything else). `updates`
//! talks to the Telegram HTTP API; `cleanup` reaps stale active agents.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::config::jobs::{JobStatus, JobsConfig};
use crate::config::settings::AppSettings;
use crate::job_context::JobContext;

use super::ActiveAgent;

mod agent;
mod cleanup;
mod dispatch;
mod updates;

pub(crate) fn lock_or_log<'a, T>(
    mutex: &'a Mutex<T>,
    _name: &str,
) -> Option<parking_lot::MutexGuard<'a, T>> {
    Some(mutex.lock())
}

pub struct AgentState {
    pub settings: Arc<Mutex<AppSettings>>,
    pub jobs_config: Arc<Mutex<JobsConfig>>,
    pub job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    pub active_agents: Arc<Mutex<HashMap<i64, ActiveAgent>>>,
    pub ctx: JobContext,
}

pub async fn start_polling(state: AgentState) {
    log::info!("Telegram agent polling started");

    let mut offset = updates::prime_offset(&state).await;

    loop {
        let config = lock_or_log(&state.settings, "settings").and_then(|s| s.telegram.clone());
        let config = match config {
            Some(c) if c.agent_enabled && c.is_configured() => c,
            _ => {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                continue;
            }
        };

        if super::is_setup_polling() {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            continue;
        }

        cleanup::cleanup_stale_agents(&state.active_agents, &config).await;

        log::debug!("Polling getUpdates (offset={:?})", offset);
        match updates::get_updates(&config.bot_token, offset, 30).await {
            Ok(items) => {
                for update in items {
                    offset = Some(update.update_id + 1);
                    dispatch::handle_update(&update, &config, &state).await;
                }
            }
            Err(e) => {
                log::error!("Telegram polling error: {}", e);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    }
}
