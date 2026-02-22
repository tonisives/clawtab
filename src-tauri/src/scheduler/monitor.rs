use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::Utc;

use crate::config::jobs::{JobStatus, TelegramLogMode};
use crate::history::HistoryStore;
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
    pub telegram_log_mode: TelegramLogMode,
    pub history: Arc<Mutex<HistoryStore>>,
    pub job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    pub notify_on_success: bool,
}

pub async fn monitor_pane(params: MonitorParams) {
    // Send "job started" notification for non-Off telegram log modes
    if params.telegram_log_mode != TelegramLogMode::Off {
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
    // For OnPrompt mode: track the most recent diff so we only send new content
    // when the pane goes stale, not the entire pane buffer.
    let mut pending_diff = String::new();

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;

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

        if trimmed != last_content && !trimmed.is_empty() {
            let new_content = diff_content(&last_content, &trimmed);
            last_content = trimmed;
            stale_ticks = 0;

            if !new_content.is_empty() {
                if params.telegram_log_mode == TelegramLogMode::Always {
                    if let Some(ref tg) = params.telegram {
                        let msg = format!("<pre>{}</pre>", html_escape(&new_content));
                        if let Err(e) =
                            crate::telegram::send_message(&tg.bot_token, tg.chat_id, &msg).await
                        {
                            log::error!("[{}] Failed to relay log output: {}", params.run_id, e);
                        }
                    }
                }
                // Accumulate diffs for OnPrompt: when the pane eventually goes
                // stale we send only the content that appeared since the last
                // prompt notification (or since the job started).
                if params.telegram_log_mode == TelegramLogMode::OnPrompt {
                    if pending_diff.is_empty() {
                        pending_diff = new_content;
                    } else {
                        pending_diff.push('\n');
                        pending_diff.push_str(&new_content);
                    }
                }
            }
        } else if !process_exited.load(Ordering::Acquire) {
            // Content unchanged while pane is still busy
            if params.telegram_log_mode == TelegramLogMode::OnPrompt {
                stale_ticks += 1;
                if stale_ticks >= 2 && !pending_diff.is_empty() {
                    if let Some(ref tg) = params.telegram {
                        let msg = format!("<pre>{}</pre>", html_escape(&pending_diff));
                        if let Err(e) =
                            crate::telegram::send_message(&tg.bot_token, tg.chat_id, &msg)
                                .await
                        {
                            log::error!(
                                "[{}] Failed to send prompt snapshot: {}",
                                params.run_id,
                                e
                            );
                        }
                    }
                    pending_diff.clear();
                    stale_ticks = 0;
                }
            }
        }

        // Break as soon as the fast poller detects the process has exited
        if process_exited.load(Ordering::Acquire) {
            break;
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
        let mut status = params.job_status.lock().unwrap();
        status.insert(
            params.job_name.clone(),
            JobStatus::Success {
                last_run: finished_at,
            },
        );
    }

    // Send completion notification
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
