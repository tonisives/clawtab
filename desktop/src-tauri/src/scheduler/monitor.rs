use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use parking_lot::Mutex;

use chrono::Utc;

use crate::config::jobs::{JobStatus, NotifyTarget, TelegramNotify};
use crate::history::HistoryStore;
use crate::relay::RelayHandle;
use crate::tmux;

const POLL_INTERVAL_SECS: u64 = 2;
const CAPTURE_LINES: u32 = 80;

pub struct TelegramStream {
    pub bot_token: String,
    pub chat_id: i64,
}

pub struct MonitorParams {
    pub tmux_session: String,
    pub pane_id: String,
    pub run_id: String,
    pub job_id: String,
    pub slug: String,
    pub kill_on_end: bool,
    pub telegram: Option<TelegramStream>,
    pub telegram_notify: TelegramNotify,
    pub notify_target: NotifyTarget,
    pub history: Arc<Mutex<HistoryStore>>,
    pub job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    pub notify_on_success: bool,
    pub relay: Arc<Mutex<Option<RelayHandle>>>,
    pub notifier: Option<Arc<dyn crate::notifications::Notifier>>,
    /// When true, skip the "job started" notification (used for reattach).
    pub is_reattach: bool,
    /// Pane IDs currently open in ClawTab's UI. Used to suppress `kill_on_end`
    /// when the user is looking at the pane.
    pub protected_panes: Arc<Mutex<HashSet<String>>>,
    /// External trigger id, set when this run was started via the triggers
    /// crate webhook. When set, the monitor reads `result_file` on finish and
    /// pushes a `DesktopMessage::TriggerResult` to the relay.
    pub trigger_id: Option<String>,
    pub result_file: Option<std::path::PathBuf>,
}

fn format_elapsed(secs: u64) -> String {
    let mins = secs / 60;
    let s = secs % 60;
    format!("{}:{:02}", mins, s)
}

const IDLE_SEND_THRESHOLD: u32 = 5; // 5 ticks * 2s = 10 seconds
const MAX_LOG_LINES: usize = 40;

struct PollState {
    last_content: String,
    pending_diff: String,
    accumulated_log: String,
    stale_ticks: u32,
    idle_ticks: u32,
    tick_counter: u32,
}

pub async fn monitor_pane(params: MonitorParams) {
    let use_telegram = params.notify_target == NotifyTarget::Telegram;
    let use_app = params.notify_target == NotifyTarget::App;
    let started_at = std::time::Instant::now();

    notify_start(&params, use_telegram, use_app).await;
    let working_message_id = init_working_message(&params, use_telegram).await;

    let mut state = PollState {
        last_content: capture_trimmed(&params.tmux_session, &params.pane_id),
        pending_diff: String::new(),
        accumulated_log: String::new(),
        stale_ticks: 0,
        idle_ticks: 0,
        tick_counter: 0,
    };

    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let process_exited = spawn_exit_poller(&params.tmux_session, &params.pane_id);

    run_poll_loop(
        &params,
        use_telegram,
        working_message_id,
        started_at,
        &process_exited,
        &mut state,
    )
    .await;

    finalize_telegram(&params, use_telegram, working_message_id).await;
    let full_output = compute_full_output(&params, state.accumulated_log);
    save_log_file(&params.slug, &params.run_id, &full_output);
    maybe_kill_pane(&params);
    persist_finish(&params, &full_output);
    notify_finish(&params, use_telegram, use_app).await;
    push_trigger_result_if_any(&params);

    log::info!("[{}] Monitor finished for job '{}'", params.run_id, params.job_id);
}

async fn notify_start(params: &MonitorParams, use_telegram: bool, use_app: bool) {
    if !params.telegram_notify.start || params.is_reattach {
        return;
    }
    if use_telegram {
        if let Some(ref tg) = params.telegram {
            let text = format!("<b>ClawTab</b>: Job <code>{}</code> started", params.job_id);
            if let Err(e) = crate::telegram::send_message(&tg.bot_token, tg.chat_id, &text).await {
                log::error!("[{}] Failed to send start notification: {}", params.run_id, e);
            }
        }
    }
    if use_app {
        crate::relay::push_job_notification(&params.relay, &params.slug, "started", &params.run_id);
        if let Some(ref n) = params.notifier {
            n.notify_job(&params.job_id, "started");
        }
    }
}

async fn init_working_message(params: &MonitorParams, use_telegram: bool) -> Option<i64> {
    if !params.telegram_notify.working || !use_telegram || params.is_reattach {
        return None;
    }
    let tg = params.telegram.as_ref()?;
    match crate::telegram::send_message_returning_id(&tg.bot_token, tg.chat_id, "Working... 0:00").await {
        Ok(mid) => Some(mid),
        Err(e) => {
            log::error!("[{}] Failed to send working message: {}", params.run_id, e);
            None
        }
    }
}

fn capture_trimmed(session: &str, pane_id: &str) -> String {
    tmux::capture_pane(session, pane_id, CAPTURE_LINES)
        .unwrap_or_default()
        .lines()
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn spawn_exit_poller(session: &str, pane_id: &str) -> Arc<AtomicBool> {
    let process_exited = Arc::new(AtomicBool::new(false));
    let exit_flag = Arc::clone(&process_exited);
    let exit_session = session.to_string();
    let exit_pane = pane_id.to_string();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if !tmux::is_pane_busy(&exit_session, &exit_pane) {
                exit_flag.store(true, Ordering::Release);
                break;
            }
        }
    });
    process_exited
}

async fn run_poll_loop(
    params: &MonitorParams,
    use_telegram: bool,
    working_message_id: Option<i64>,
    started_at: std::time::Instant,
    process_exited: &Arc<AtomicBool>,
    state: &mut PollState,
) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
        state.tick_counter += 1;

        let Some(trimmed) = capture_or_break(params) else {
            break;
        };

        maybe_update_working_message(params, use_telegram, working_message_id, started_at, state.tick_counter).await;
        handle_capture_diff(params, use_telegram, process_exited, state, trimmed).await;
        maybe_flush_idle_logs(params, use_telegram, state).await;

        if process_exited.load(Ordering::Acquire) {
            break;
        }
    }
}

fn capture_or_break(params: &MonitorParams) -> Option<String> {
    match tmux::capture_pane(&params.tmux_session, &params.pane_id, CAPTURE_LINES) {
        Ok(c) => Some(c.lines().collect::<Vec<_>>().join("\n").trim().to_string()),
        Err(e) => {
            log::warn!("[{}] Failed to capture pane {}: {}", params.run_id, params.pane_id, e);
            None
        }
    }
}

async fn maybe_update_working_message(
    params: &MonitorParams,
    use_telegram: bool,
    working_message_id: Option<i64>,
    started_at: std::time::Instant,
    tick_counter: u32,
) {
    if !params.telegram_notify.working || !use_telegram || !tick_counter.is_multiple_of(4) {
        return;
    }
    let Some(tg) = params.telegram.as_ref() else { return };
    let elapsed = started_at.elapsed().as_secs();
    let working_text = format!("Working... {}", format_elapsed(elapsed));
    if let Some(mid) = working_message_id {
        if let Err(e) = crate::telegram::edit_message_text(&tg.bot_token, tg.chat_id, mid, &working_text).await {
            log::warn!("[{}] Failed to update working message: {}", params.run_id, e);
        }
    }
    let _ = crate::telegram::send_chat_action(&tg.bot_token, tg.chat_id, "typing").await;
}

async fn handle_capture_diff(
    params: &MonitorParams,
    use_telegram: bool,
    process_exited: &Arc<AtomicBool>,
    state: &mut PollState,
    trimmed: String,
) {
    if trimmed != state.last_content && !trimmed.is_empty() {
        let new_content = diff_content(&state.last_content, &trimmed);
        state.last_content = trimmed;
        state.stale_ticks = 0;
        update_idle_ticks_for_content(state, &new_content);
        accumulate_and_push_log(params, state, &new_content, use_telegram);
    } else if !process_exited.load(Ordering::Acquire) {
        state.idle_ticks += 1;
        if params.telegram_notify.logs && use_telegram {
            maybe_flush_stale_pending(params, state).await;
        }
    }
}

fn update_idle_ticks_for_content(state: &mut PollState, new_content: &str) {
    let is_substantial = new_content
        .lines()
        .any(|line| line.chars().filter(|c| !c.is_whitespace()).count() >= 5);
    if is_substantial {
        state.idle_ticks = 0;
    } else {
        state.idle_ticks += 1;
    }
}

fn accumulate_and_push_log(
    params: &MonitorParams,
    state: &mut PollState,
    new_content: &str,
    use_telegram: bool,
) {
    if new_content.is_empty() {
        return;
    }
    if !state.accumulated_log.is_empty() {
        state.accumulated_log.push('\n');
    }
    state.accumulated_log.push_str(new_content);
    crate::relay::push_log_chunk(&params.relay, &params.slug, new_content);
    if params.telegram_notify.logs && use_telegram {
        if state.pending_diff.is_empty() {
            state.pending_diff = new_content.to_string();
        } else {
            state.pending_diff.push('\n');
            state.pending_diff.push_str(new_content);
        }
    }
}

async fn maybe_flush_stale_pending(params: &MonitorParams, state: &mut PollState) {
    state.stale_ticks += 1;
    if state.stale_ticks < 2 || state.pending_diff.is_empty() {
        return;
    }
    if let Some(ref tg) = params.telegram {
        let msg = format!("<pre>{}</pre>", html_escape(&state.pending_diff));
        if let Err(e) = crate::telegram::send_message(&tg.bot_token, tg.chat_id, &msg).await {
            log::error!("[{}] Failed to send log snapshot: {}", params.run_id, e);
        }
    }
    state.pending_diff.clear();
    state.stale_ticks = 0;
    state.idle_ticks = 0;
}

async fn maybe_flush_idle_logs(params: &MonitorParams, use_telegram: bool, state: &mut PollState) {
    if !params.telegram_notify.logs
        || !use_telegram
        || state.idle_ticks < IDLE_SEND_THRESHOLD
        || state.pending_diff.is_empty()
    {
        return;
    }
    if let Some(ref tg) = params.telegram {
        let tail_lines: Vec<&str> = state.pending_diff.lines().collect();
        let start = tail_lines.len().saturating_sub(MAX_LOG_LINES);
        let snippet = tail_lines[start..].join("\n");
        if !snippet.trim().is_empty() {
            let msg = format!("<pre>{}</pre>", html_escape(&snippet));
            if let Err(e) = crate::telegram::send_message(&tg.bot_token, tg.chat_id, &msg).await {
                log::error!("[{}] Failed to send idle log snapshot: {}", params.run_id, e);
            }
        }
    }
    state.pending_diff.clear();
    state.idle_ticks = 0;
    state.stale_ticks = 0;
}

async fn finalize_telegram(
    params: &MonitorParams,
    use_telegram: bool,
    working_message_id: Option<i64>,
) {
    if !use_telegram {
        return;
    }
    if let (Some(tg), Some(mid)) = (params.telegram.as_ref(), working_message_id) {
        if let Err(e) = crate::telegram::delete_message(&tg.bot_token, tg.chat_id, mid).await {
            log::warn!("[{}] Failed to delete working message: {}", params.run_id, e);
        }
    }
    if params.telegram_notify.finish {
        send_final_snapshot(params).await;
    }
}

async fn send_final_snapshot(params: &MonitorParams) {
    let Some(tg) = params.telegram.as_ref() else { return };
    let final_trimmed = capture_trimmed(&params.tmux_session, &params.pane_id);
    if final_trimmed.is_empty() {
        return;
    }
    let lines: Vec<&str> = final_trimmed.lines().collect();
    let start = lines.len().saturating_sub(MAX_LOG_LINES);
    let snippet = lines[start..].join("\n");
    if snippet.trim().is_empty() {
        return;
    }
    let msg = format!("<pre>{}</pre>", html_escape(&snippet));
    if let Err(e) = crate::telegram::send_message(&tg.bot_token, tg.chat_id, &msg).await {
        log::error!("[{}] Failed to send final log snapshot: {}", params.run_id, e);
    }
}

fn compute_full_output(params: &MonitorParams, accumulated_log: String) -> String {
    let full_output = tmux::capture_pane_full(&params.pane_id)
        .unwrap_or_default()
        .trim()
        .to_string();
    if full_output.is_empty() && !accumulated_log.is_empty() {
        log::info!(
            "[{}] Full pane capture was empty, using accumulated log ({} bytes)",
            params.run_id, accumulated_log.len(),
        );
        accumulated_log
    } else {
        full_output
    }
}

fn maybe_kill_pane(params: &MonitorParams) {
    if !params.kill_on_end {
        return;
    }
    let is_protected = params.protected_panes.lock().contains(&params.pane_id);
    if is_protected {
        log::warn!(
            "[{}] Skipping kill_on_end for pane {} - pane is open in ClawTab",
            params.run_id, params.pane_id,
        );
    } else if let Err(e) = tmux::kill_pane(&params.pane_id) {
        log::warn!("[{}] Failed to kill pane {}: {}", params.run_id, params.pane_id, e);
    }
}

fn persist_finish(params: &MonitorParams, full_output: &str) {
    let finished_at = Utc::now().to_rfc3339();
    {
        let h = params.history.lock();
        if let Err(e) = h.update_finished(&params.run_id, &finished_at, Some(0), full_output, "") {
            log::error!("[{}] Failed to update history: {}", params.run_id, e);
        }
    }
    let new_status = JobStatus::Success { last_run: finished_at };
    let mut status = params.job_status.lock();
    status.insert(params.slug.clone(), new_status.clone());
    drop(status);
    crate::relay::push_status_update(&params.relay, &params.slug, &new_status);
}

async fn notify_finish(params: &MonitorParams, use_telegram: bool, use_app: bool) {
    if !params.telegram_notify.finish {
        return;
    }
    if use_telegram {
        if let Some(ref tg) = params.telegram {
            if params.notify_on_success {
                let text = format!("<b>ClawTab</b>: Job <code>{}</code> completed", params.job_id);
                if let Err(e) = crate::telegram::send_message(&tg.bot_token, tg.chat_id, &text).await {
                    log::error!("[{}] Failed to send completion notification: {}", params.run_id, e);
                }
            }
        }
    }
    if use_app {
        crate::relay::push_job_notification(&params.relay, &params.slug, "completed", &params.run_id);
        if let Some(ref n) = params.notifier {
            n.notify_job(&params.job_id, "completed");
        }
    }
}

fn push_trigger_result_if_any(params: &MonitorParams) {
    let Some(tid) = params.trigger_id.as_ref() else { return };
    let parsed = params
        .result_file
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    crate::relay::push_trigger_result(&params.relay, tid, "succeeded", Some(0), parsed, None);
}

pub(crate) fn save_log_file(slug: &str, run_id: &str, content: &str) {
    let dir = match crate::config::config_dir() {
        Some(d) => d.join("jobs").join(slug).join("logs"),
        None => return,
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::error!("Failed to create log dir {}: {}", dir.display(), e);
        return;
    }
    let path = dir.join(format!("{}.log", run_id));
    if let Err(e) = std::fs::write(&path, content) {
        log::error!("Failed to write log file {}: {}", path.display(), e);
    } else {
        log::info!("Saved log to {}", path.display());
    }
}

fn diff_content(previous: &str, current: &str) -> String {
    if previous.is_empty() {
        return current.to_string();
    }

    let prev_lines: Vec<&str> = previous.lines().collect();
    let curr_lines: Vec<&str> = current.lines().collect();

    // Try multiple anchor candidates from the end of previous capture.
    // If the last line is a common/empty string, try earlier lines.
    for anchor in prev_lines.iter().rev().filter(|l| !l.is_empty()) {
        if let Some(pos) = curr_lines.iter().rposition(|l| l == anchor) {
            return if pos + 1 < curr_lines.len() {
                curr_lines[pos + 1..].join("\n")
            } else {
                String::new()
            };
        }
    }

    // No anchor found -- buffer scrolled completely past the previous capture.
    // Return empty to avoid re-sending content that likely overlaps with what
    // was already sent in earlier ticks.
    String::new()
}

fn html_escape(s: &str) -> String {
    crate::telegram::strip_ansi(s)
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
