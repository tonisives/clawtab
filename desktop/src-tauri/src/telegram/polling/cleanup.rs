//! Reaps active_agents entries whose tmux panes have died.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::telegram::ActiveAgent;
use crate::tmux;

use super::lock_or_log;

pub(super) fn cleanup_stale_agents(active_agents: &Arc<Mutex<HashMap<i64, ActiveAgent>>>) {
    let stale: Vec<(i64, String)> = match lock_or_log(active_agents, "active_agents") {
        Some(agents) => agents
            .iter()
            .filter(|(_, agent)| !tmux::is_pane_busy(&agent.tmux_session, &agent.pane_id))
            .map(|(&chat_id, agent)| (chat_id, agent.job_id.clone()))
            .collect(),
        None => return,
    };

    for (chat_id, job_id) in stale {
        if let Some(mut agents) = lock_or_log(active_agents, "active_agents") {
            agents.remove(&chat_id);
        }
        log::info!(
            "Cleaned up stale session for job '{}' chat {}",
            job_id,
            chat_id
        );
    }
}
