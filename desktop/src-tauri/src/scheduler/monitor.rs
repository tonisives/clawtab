use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

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
    pub job_name: String,
    pub slug: String,
    pub telegram: Option<TelegramStream>,
    pub telegram_notify: TelegramNotify,
    pub notify_target: NotifyTarget,
    pub history: Arc<Mutex<HistoryStore>>,
    pub job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    pub notify_on_success: bool,
    pub relay: Arc<Mutex<Option<RelayHandle>>>,
}

fn format_elapsed(secs: u64) -> String {
    let mins = secs / 60;
    let s = secs % 60;
    format!("{}:{:02}", mins, s)
}

pub async fn monitor_pane(params: MonitorParams) {
    let notify = &params.telegram_notify;
    let use_telegram = params.notify_target == NotifyTarget::Telegram;
    let use_app = params.notify_target == NotifyTarget::App;
    let mut working_message_id: Option<i64> = None;
    let started_at = std::time::Instant::now();

    // Send "job started" notification
    if notify.start {
        if use_telegram {
            if let Some(ref tg) = params.telegram {
                let text = format!(
                    "<b>ClawTab</b>: Job <code>{}</code> started",
                    params.job_name
                );
                if let Err(e) = crate::telegram::send_message(&tg.bot_token, tg.chat_id, &text).await {
                    log::error!("[{}] Failed to send start notification: {}", params.run_id, e);
                }
            }
        }
        if use_app {
            crate::relay::push_job_notification(&params.relay, &params.job_name, "started");
        }
    }

    // Send initial working status message (Telegram only)
    if notify.working && use_telegram {
        if let Some(ref tg) = params.telegram {
            match crate::telegram::send_message_returning_id(
                &tg.bot_token,
                tg.chat_id,
                "Working... 0:00",
            )
            .await
            {
                Ok(mid) => working_message_id = Some(mid),
                Err(e) => {
                    log::error!("[{}] Failed to send working message: {}", params.run_id, e);
                }
            }
        }
    }

    // Capture whatever is already in the pane before the job produces output.
    // This seeds the baseline so we only relay genuinely new content to Telegram,
    // avoiding re-sending scrollback from previous runs in the same pane.
    let mut last_content = tmux::capture_pane(
        &params.tmux_session,
        &params.pane_id,
        CAPTURE_LINES,
    )
    .unwrap_or_default()
    .lines()
    .collect::<Vec<_>>()
    .join("\n")
    .trim()
    .to_string();

    // Brief pause to let the process start
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    // Spawn a fast background poller that detects process exit within ~200ms
    let process_exited = Arc::new(AtomicBool::new(false));
    let exit_flag = Arc::clone(&process_exited);
    let exit_session = params.tmux_session.clone();
    let exit_pane = params.pane_id.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if !tmux::is_pane_busy(&exit_session, &exit_pane) {
                exit_flag.store(true, Ordering::Release);
                break;
            }
        }
    });

    let mut stale_ticks = 0u32;
    let mut tick_counter = 0u32;
    // Accumulate diffs so we only send new content when the pane goes stale.
    let mut pending_diff = String::new();
    // Track how many ticks since the last substantial content change.
    // "Substantial" means at least one diff line with 5+ non-whitespace chars,
    // filtering out spinner/animation updates that constantly change the pane.
    let mut idle_ticks = 0u32;
    const IDLE_SEND_THRESHOLD: u32 = 5; // 5 ticks * 2s = 10 seconds
    const MAX_LOG_LINES: usize = 40;

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
        tick_counter += 1;

        let capture = match tmux::capture_pane(
            &params.tmux_session,
            &params.pane_id,
            CAPTURE_LINES,
        ) {
            Ok(c) => c,
            Err(e) => {
                log::warn!(
                    "[{}] Failed to capture pane {}: {}",
                    params.run_id,
                    params.pane_id,
                    e
                );
                break;
            }
        };

        let trimmed: String = capture.lines().collect::<Vec<_>>().join("\n").trim().to_string();

        // Update working message and typing indicator every ~4 ticks (8 seconds, Telegram only)
        if notify.working && use_telegram && tick_counter % 4 == 0 {
            if let Some(ref tg) = params.telegram {
                let elapsed = started_at.elapsed().as_secs();
                let working_text = format!("Working... {}", format_elapsed(elapsed));

                if let Some(mid) = working_message_id {
                    if let Err(e) = crate::telegram::edit_message_text(
                        &tg.bot_token,
                        tg.chat_id,
                        mid,
                        &working_text,
                    )
                    .await
                    {
                        log::warn!("[{}] Failed to update working message: {}", params.run_id, e);
                    }
                }

                let _ =
                    crate::telegram::send_chat_action(&tg.bot_token, tg.chat_id, "typing").await;
            }
        }

        if trimmed != last_content && !trimmed.is_empty() {
            let new_content = diff_content(&last_content, &trimmed);
            last_content = trimmed;
            stale_ticks = 0;

            let is_substantial = new_content.lines().any(|line| {
                line.chars().filter(|c| !c.is_whitespace()).count() >= 5
            });

            if is_substantial {
                idle_ticks = 0;
            } else {
                idle_ticks += 1;
            }

            // Push log diffs to relay
            if !new_content.is_empty() {
                crate::relay::push_log_chunk(&params.relay, &params.job_name, &new_content);
            }

            if notify.logs && use_telegram && !new_content.is_empty() {
                if pending_diff.is_empty() {
                    pending_diff = new_content;
                } else {
                    pending_diff.push('\n');
                    pending_diff.push_str(&new_content);
                }
            }
        } else if !process_exited.load(Ordering::Acquire) {
            // Content unchanged while pane is still busy
            idle_ticks += 1;
            if notify.logs && use_telegram {
                stale_ticks += 1;
                if stale_ticks >= 2 && !pending_diff.is_empty() {
                    if let Some(ref tg) = params.telegram {
                        let msg = format!("<pre>{}</pre>", html_escape(&pending_diff));
                        if let Err(e) =
                            crate::telegram::send_message(&tg.bot_token, tg.chat_id, &msg)
                                .await
                        {
                            log::error!(
                                "[{}] Failed to send log snapshot: {}",
                                params.run_id,
                                e
                            );
                        }
                    }
                    pending_diff.clear();
                    stale_ticks = 0;
                    idle_ticks = 0;
                }
            }
        }

        // If idle for 10s with accumulated logs, send the last N lines (Telegram only)
        if notify.logs
            && use_telegram
            && idle_ticks >= IDLE_SEND_THRESHOLD
            && !pending_diff.is_empty()
        {
            if let Some(ref tg) = params.telegram {
                let tail_lines: Vec<&str> = pending_diff.lines().collect();
                let start = tail_lines.len().saturating_sub(MAX_LOG_LINES);
                let snippet = tail_lines[start..].join("\n");
                if !snippet.trim().is_empty() {
                    let msg = format!("<pre>{}</pre>", html_escape(&snippet));
                    if let Err(e) =
                        crate::telegram::send_message(&tg.bot_token, tg.chat_id, &msg).await
                    {
                        log::error!(
                            "[{}] Failed to send idle log snapshot: {}",
                            params.run_id,
                            e
                        );
                    }
                }
            }
            pending_diff.clear();
            idle_ticks = 0;
            stale_ticks = 0;
        }

        // Break as soon as the fast poller detects the process has exited
        if process_exited.load(Ordering::Acquire) {
            break;
        }
    }

    // Delete the working message now that the job is done (Telegram only)
    if use_telegram {
        if let Some(ref tg) = params.telegram {
            if let Some(mid) = working_message_id {
                if let Err(e) =
                    crate::telegram::delete_message(&tg.bot_token, tg.chat_id, mid).await
                {
                    log::warn!("[{}] Failed to delete working message: {}", params.run_id, e);
                }
            }
        }
    }

    // Send final pane snapshot to Telegram (last visible state before exit)
    if notify.finish && use_telegram {
        if let Some(ref tg) = params.telegram {
            let final_capture = tmux::capture_pane(
                &params.tmux_session,
                &params.pane_id,
                CAPTURE_LINES,
            )
            .unwrap_or_default();
            let final_trimmed: String = final_capture
                .lines()
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();

            if !final_trimmed.is_empty() {
                let lines: Vec<&str> = final_trimmed.lines().collect();
                let start = lines.len().saturating_sub(MAX_LOG_LINES);
                let snippet = lines[start..].join("\n");
                if !snippet.trim().is_empty() {
                    let msg = format!("<pre>{}</pre>", html_escape(&snippet));
                    if let Err(e) =
                        crate::telegram::send_message(&tg.bot_token, tg.chat_id, &msg).await
                    {
                        log::error!(
                            "[{}] Failed to send final log snapshot: {}",
                            params.run_id,
                            e
                        );
                    }
                }
            }
        }
    }

    // Capture full scrollback for history (not sent to Telegram)
    let full_output = tmux::capture_pane_full(&params.pane_id).unwrap_or_default();
    let full_output = full_output.trim().to_string();

    // Save log file to disk
    save_log_file(&params.slug, &params.run_id, &full_output);

    // Close the tmux pane now that output has been captured
    if let Err(e) = tmux::kill_pane(&params.pane_id) {
        log::warn!("[{}] Failed to kill pane {}: {}", params.run_id, params.pane_id, e);
    }

    let finished_at = Utc::now().to_rfc3339();

    // Update history with captured output
    {
        let h = params.history.lock().unwrap();
        if let Err(e) = h.update_finished(&params.run_id, &finished_at, Some(0), &full_output, "")
        {
            log::error!("[{}] Failed to update history: {}", params.run_id, e);
        }
    }

    // Update job status to Success
    {
        let new_status = JobStatus::Success {
            last_run: finished_at,
        };
        let mut status = params.job_status.lock().unwrap();
        status.insert(params.job_name.clone(), new_status.clone());
        drop(status);
        crate::relay::push_status_update(&params.relay, &params.job_name, &new_status);
    }

    // Send completion notification
    if notify.finish {
        if use_telegram {
            if let Some(ref tg) = params.telegram {
                if params.notify_on_success {
                    let text = format!(
                        "<b>ClawTab</b>: Job <code>{}</code> completed",
                        params.job_name
                    );
                    if let Err(e) = crate::telegram::send_message(&tg.bot_token, tg.chat_id, &text).await
                    {
                        log::error!("[{}] Failed to send completion notification: {}", params.run_id, e);
                    }
                }
            }
        }
        if use_app {
            crate::relay::push_job_notification(&params.relay, &params.job_name, "completed");
        }
    }

    log::info!(
        "[{}] Monitor finished for job '{}'",
        params.run_id,
        params.job_name
    );
}

fn save_log_file(slug: &str, run_id: &str, content: &str) {
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
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
