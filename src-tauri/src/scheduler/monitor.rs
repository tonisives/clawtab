use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;

use crate::config::jobs::JobStatus;
use crate::history::HistoryStore;
use crate::tmux;

const POLL_INTERVAL_SECS: u64 = 5;
const CAPTURE_LINES: u32 = 80;
const MAX_IDLE_TICKS: u32 = 5;

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
    pub history: Arc<Mutex<HistoryStore>>,
    pub job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    pub notify_on_success: bool,
}

pub async fn monitor_pane(params: MonitorParams) {
    // Wait for the process to start producing output
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    let mut last_content = String::new();
    let mut idle_ticks = 0u32;

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
            idle_ticks = 0;

            if !new_content.is_empty() {
                if let Some(ref tg) = params.telegram {
                    let msg = format!("<pre>{}</pre>", html_escape(&new_content));
                    if let Err(e) =
                        crate::telegram::send_message(&tg.bot_token, tg.chat_id, &msg).await
                    {
                        log::error!("[{}] Failed to relay log output: {}", params.run_id, e);
                    }
                }
            }
        } else {
            let busy = tmux::is_pane_busy(&params.tmux_session, &params.pane_id);
            if !busy {
                idle_ticks += 1;
                if idle_ticks >= MAX_IDLE_TICKS {
                    break;
                }
            }
        }
    }

    // Capture full scrollback and finalize
    let full_output = tmux::capture_pane_full(&params.pane_id).unwrap_or_default();
    let full_output = full_output.trim().to_string();

    // Save log file to disk
    save_log_file(&params.slug, &params.run_id, &full_output);

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
                "<b>ClawdTab</b>: Job <code>{}</code> completed",
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
        current.to_string()
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
