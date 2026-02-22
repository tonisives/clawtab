use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
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

/// Strip leading cursor/arrow markers from an option line.
/// Claude Code uses '>' or U+276F (❯) as selection indicators.
fn strip_option_marker(s: &str) -> &str {
    let t = s.trim();
    for prefix in &[">", "\u{276F}"] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return rest.trim_start();
        }
    }
    t
}

/// A detected numbered-choice prompt with its question and individual options.
struct DetectedPrompt {
    question: String,
    /// Options with their full text (e.g. "1. Yes", "2. No").
    options: Vec<String>,
}

/// Detect numbered-choice prompts (e.g. Claude Code permission dialogs) in pane content.
/// Returns structured prompt data if a prompt with 2+ numbered options is found.
///
/// Handles two layouts:
/// 1. Options on separate lines:
///    ```text
///    Do you want to make this edit?
///    > 1. Yes
///      2. No
///      3. Yes, allow all edits during this session
///    ```
/// 2. Options on a single line (compact Claude Code style):
///    ```text
///    Do you want to proceed?
///    > 1. Yes 2. No
///    ```
fn detect_numbered_prompt(content: &str) -> Option<DetectedPrompt> {
    let lines: Vec<&str> = content.lines().collect();
    let start = if lines.len() > 20 { lines.len() - 20 } else { 0 };
    let tail = &lines[start..];

    // Check if a line starts with an option pattern `[marker] N. text`
    let line_starts_with_option = |line: &str| -> bool {
        let trimmed = strip_option_marker(line);
        let mut chars = trimmed.chars();
        match chars.next() {
            Some(c) if c.is_ascii_digit() => {}
            _ => return false,
        }
        let rest: String = chars.collect();
        rest.starts_with(". ") && rest.len() > 2
    };

    // Extract individual options from a line that may contain multiple options.
    // e.g. "> 1. Yes 2. No" -> ["1. Yes", "2. No"]
    // e.g. "1. Yes, allow all edits during this session (shift+tab)" -> single option
    let extract_options = |line: &str| -> Vec<String> {
        let trimmed = strip_option_marker(line);

        // Find all positions where ` N. ` starts a new option (space + digit(s) + ". ")
        // The first option starts at position 0 (no leading space).
        let mut option_starts: Vec<usize> = Vec::new();

        // Check if the string itself starts with an option
        if trimmed.starts_with(|c: char| c.is_ascii_digit()) {
            let digit_end = trimmed.find(|c: char| !c.is_ascii_digit()).unwrap_or(trimmed.len());
            if trimmed[digit_end..].starts_with(". ") {
                option_starts.push(0);
            }
        }

        // Find subsequent options: ` N. ` pattern
        let bytes = trimmed.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b' ' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
                let after = &trimmed[i + 1..];
                let digit_end = after.find(|c: char| !c.is_ascii_digit()).unwrap_or(after.len());
                if digit_end > 0 && after[digit_end..].starts_with(". ") {
                    option_starts.push(i + 1);
                    i += 1 + digit_end + 2; // skip past "N. "
                    continue;
                }
            }
            i += 1;
        }

        if option_starts.is_empty() {
            return Vec::new();
        }

        let mut options = Vec::new();
        for (idx, &start) in option_starts.iter().enumerate() {
            let end = if idx + 1 < option_starts.len() {
                // End just before the space preceding the next option
                option_starts[idx + 1] - 1
            } else {
                trimmed.len()
            };
            options.push(trimmed[start..end].trim().to_string());
        }
        options
    };

    // Find the first line that contains option(s)
    let first_opt_line = tail.iter().position(|l| line_starts_with_option(l))?;

    // Collect all consecutive option lines
    let mut last_opt_line = first_opt_line;
    for i in (first_opt_line + 1)..tail.len() {
        if line_starts_with_option(tail[i]) {
            last_opt_line = i;
        } else {
            break;
        }
    }

    // Gather all options from these lines
    let mut options: Vec<String> = Vec::new();
    for i in first_opt_line..=last_opt_line {
        options.extend(extract_options(tail[i]));
    }

    if options.len() < 2 {
        return None;
    }

    // Question line is the non-empty line immediately before the first option
    let question = if first_opt_line > 0 {
        let mut q_idx = first_opt_line - 1;
        while q_idx > 0 && tail[q_idx].trim().is_empty() {
            q_idx -= 1;
        }
        tail[q_idx].trim().to_string()
    } else {
        String::new()
    };

    Some(DetectedPrompt { question, options })
}

fn hash_string(s: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

fn format_elapsed(secs: u64) -> String {
    let mins = secs / 60;
    let s = secs % 60;
    format!("{}:{:02}", mins, s)
}

pub async fn monitor_pane(params: MonitorParams) {
    // Send "job started" notification and working status message for non-Off modes
    let mut working_message_id: Option<i64> = None;
    let started_at = std::time::Instant::now();

    if params.telegram_log_mode != TelegramLogMode::Off {
        if let Some(ref tg) = params.telegram {
            let text = format!(
                "<b>ClawTab</b>: Job <code>{}</code> started",
                params.job_name
            );
            if let Err(e) = crate::telegram::send_message(&tg.bot_token, tg.chat_id, &text).await {
                log::error!("[{}] Failed to send start notification: {}", params.run_id, e);
            }

            // Send initial working status message
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
    // For OnPrompt mode: track the most recent diff so we only send new content
    // when the pane goes stale, not the entire pane buffer.
    let mut pending_diff = String::new();
    // Track last prompt hash to avoid re-sending the same numbered prompt
    let mut last_prompt_hash: Option<u64> = None;
    // Track how many ticks since the last substantial content change.
    // "Substantial" means at least one diff line with 5+ non-whitespace chars,
    // filtering out spinner/animation updates that constantly change the pane.
    let mut idle_ticks = 0u32;
    const IDLE_SEND_THRESHOLD: u32 = 5; // 5 ticks * 2s = 10 seconds
    const MAX_IDLE_LOG_LINES: usize = 10;

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

        // Detect numbered-choice prompts and forward to Telegram with inline buttons
        if let Some(ref tg) = params.telegram {
            if let Some(prompt) = detect_numbered_prompt(&trimmed) {
                // Hash question + options together for dedup
                let hash_input = format!("{}|{}", prompt.question, prompt.options.join("|"));
                let h = hash_string(&hash_input);
                if last_prompt_hash != Some(h) {
                    last_prompt_hash = Some(h);

                    // Build message text: show the question
                    let msg_text = if prompt.question.is_empty() {
                        "Choose an option:".to_string()
                    } else {
                        prompt.question.clone()
                    };

                    // Build inline keyboard buttons from options.
                    // Each option like "1. Yes" becomes button with label "1. Yes"
                    // and callback_data = just the number.
                    let buttons: Vec<(String, String)> = prompt
                        .options
                        .iter()
                        .map(|opt| {
                            let number = opt
                                .chars()
                                .take_while(|c| c.is_ascii_digit())
                                .collect::<String>();
                            (opt.clone(), number)
                        })
                        .collect();

                    if let Err(e) = crate::telegram::send_message_with_inline_keyboard(
                        &tg.bot_token,
                        tg.chat_id,
                        &msg_text,
                        &buttons,
                    )
                    .await
                    {
                        log::error!(
                            "[{}] Failed to send numbered prompt: {}",
                            params.run_id,
                            e
                        );
                    }
                }
            } else {
                // No prompt detected -- reset hash so a future identical prompt gets sent
                last_prompt_hash = None;
            }
        }

        // Update working message and typing indicator every ~4 ticks (8 seconds)
        if tick_counter % 4 == 0 {
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

            // Check if the diff is "substantial" (not just spinner/animation noise).
            // A line with 5+ non-whitespace chars is considered meaningful.
            let is_substantial = new_content.lines().any(|line| {
                line.chars().filter(|c| !c.is_whitespace()).count() >= 5
            });

            if is_substantial {
                idle_ticks = 0;
            } else {
                idle_ticks += 1;
            }

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
            idle_ticks += 1;
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
                    idle_ticks = 0;
                }
            }
        }

        // If idle for 10s with accumulated logs, send the last N lines
        if params.telegram_log_mode == TelegramLogMode::OnPrompt
            && idle_ticks >= IDLE_SEND_THRESHOLD
            && !pending_diff.is_empty()
        {
            if let Some(ref tg) = params.telegram {
                let tail_lines: Vec<&str> = pending_diff.lines().collect();
                let start = tail_lines.len().saturating_sub(MAX_IDLE_LOG_LINES);
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

    // Delete the working message now that the job is done
    if let Some(ref tg) = params.telegram {
        if let Some(mid) = working_message_id {
            if let Err(e) =
                crate::telegram::delete_message(&tg.bot_token, tg.chat_id, mid).await
            {
                log::warn!("[{}] Failed to delete working message: {}", params.run_id, e);
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
