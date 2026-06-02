use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use clawtab_protocol::{ClaudeQuestion, QuestionOption};

use crate::agent_session::{detect_process_provider, ProcessSnapshot};
use crate::config::jobs::{JobStatus, JobsConfig};
use crate::config::settings::AppSettings;
use crate::relay::RelayHandle;

/// Strip ANSI escape sequences from text.
fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                // CSI sequences: ESC [ ... (letter)
                Some(&'[') => {
                    chars.next();
                    while let Some(&next) = chars.peek() {
                        chars.next();
                        if next.is_ascii_alphabetic() {
                            break;
                        }
                    }
                }
                // OSC sequences: ESC ] ... (ST or BEL)
                Some(&']') => {
                    chars.next();
                    while let Some(&next) = chars.peek() {
                        chars.next();
                        if next == '\x07' {
                            break;
                        } // BEL
                        if next == '\x1b' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                // Other ESC sequences (ESC + single char like ESC ( B)
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// Parse numbered options from interactive terminal output.
/// Matches lines like "1. Fix the bug" or "  > 2. Skip this step"
/// Only returns options if the output looks like an interactive prompt
/// (contains prompt indicators like navigation hints or approval text.)
pub fn parse_numbered_options(text: &str) -> Vec<QuestionOption> {
    let text = &strip_ansi(text);
    let lines: Vec<&str> = text.lines().collect();
    let tail = if lines.len() > 30 {
        &lines[lines.len() - 30..]
    } else {
        &lines
    };

    // Collect all contiguous groups of numbered items, keep only the last group.
    // This avoids picking up numbered plans/lists that appear before the actual prompt.
    let mut groups: Vec<Vec<QuestionOption>> = Vec::new();
    let mut current_group: Vec<QuestionOption> = Vec::new();

    for line in tail {
        let trimmed =
            line.trim_start_matches(|c: char| c.is_whitespace() || ">~`|›»❯▸▶".contains(c));
        if let Some(rest) = trimmed.strip_prefix(|c: char| c.is_ascii_digit()) {
            let digit_end = rest.find(". ");
            if let Some(dot_pos) = digit_end {
                let number_str = &trimmed[..trimmed.len() - rest.len() + dot_pos];
                if number_str.chars().all(|c| c.is_ascii_digit()) {
                    let mut label = rest[dot_pos + 2..].trim().to_string();
                    if !label.is_empty() {
                        // Truncate long labels (e.g. "Yes, and don't ask again: mkdir -p ...")
                        if label.len() > 60 {
                            let mut end = 60;
                            while end > 0 && !label.is_char_boundary(end) {
                                end -= 1;
                            }
                            label = format!("{}...", label[..end].trim_end());
                        }
                        current_group.push(QuestionOption {
                            number: number_str.to_string(),
                            label,
                            selected: false,
                            col: 0,
                        });
                        continue;
                    }
                }
            }
        }
        // Only break the group on lines that look like real content (not
        // description lines, separators, or blanks between numbered options).
        // Description lines are indented text under an option, separator lines
        // are made of box-drawing chars / dashes, and blank lines appear between
        // option sections (e.g. before "Chat about this").
        if !current_group.is_empty() {
            let stripped = line.trim();
            let is_blank = stripped.is_empty();
            let is_separator =
                !stripped.is_empty() && stripped.chars().all(|c| "─━═-—–_│|┊┆".contains(c));
            let is_indented_desc = line.starts_with("  ") || line.starts_with('\t');
            if !is_blank && !is_separator && !is_indented_desc {
                groups.push(std::mem::take(&mut current_group));
            }
        }
    }
    if !current_group.is_empty() {
        groups.push(current_group);
    }

    let options = groups.into_iter().last().unwrap_or_default();

    if options.is_empty() {
        return options;
    }

    if !has_interactive_prompt_indicator(text) {
        return Vec::new();
    }

    options
}

/// Check whether the terminal output contains indicators of an interactive prompt.
/// Claude/Codex use two common kinds of numbered prompts:
///   Option menus: "Enter to select · ↑/↓ to navigate · Esc to cancel"
///   Tool permissions: "Esc to cancel · Tab to amend · ctrl+e to explain"
/// Both should be detected so notification cards appear for all interactive prompts.
/// Checks the last 12 non-empty lines (not just the very last) to handle trailing
/// whitespace or invisible characters left by TUI rendering.
fn has_interactive_prompt_indicator(text: &str) -> bool {
    let tail: Vec<String> = text
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(12)
        .map(|line| line.to_lowercase())
        .collect();

    for lower in &tail {
        if lower.contains("enter to select")
            || lower.contains("to navigate")
            || lower.contains("tab to amend")
            || lower.contains("esc to cancel")
        {
            return true;
        }
    }

    let joined = tail.join("\n");
    joined.contains("would you like to run the following command")
        || joined.contains("would you like to run this command")
        || joined.contains("yes, proceed (y)")
}

/// Check whether stripped terminal output looks like an opencode select-box prompt.
/// Opencode shows buttons like "Allow once  Allow always  Reject" with a hint line
/// containing keyboard shortcut hints like "⇆ select  enter confirm".
/// We require "enter confirm" as the specific pattern to avoid false positives from
/// prose text that incidentally contains "select" and "confirm".
fn has_opencode_prompt_indicator(text: &str) -> bool {
    let tail: Vec<String> = text
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(12)
        .map(|line| line.to_lowercase())
        .collect();

    for lower in &tail {
        // "enter confirm" is the specific opencode keyboard hint pattern
        if lower.contains("enter confirm") {
            return true;
        }
    }
    false
}

/// Parse opencode-style select-box buttons from raw ANSI terminal output.
///
/// Opencode renders permission prompts as horizontally-arranged buttons on a single
/// line, with the selected button highlighted (orange bg: 48;2;245;167;66).
/// The same line also contains keyboard hints like "ctrl+f fullscreen  ⇆ select  enter confirm".
///
/// Returns a tuple of (options, button_row_index) where button_row_index is the
/// 0-indexed line number in the captured text.
pub fn parse_opencode_buttons(ansi_text: &str) -> (Vec<QuestionOption>, u16) {
    let stripped = strip_ansi(ansi_text);
    if !has_opencode_prompt_indicator(&stripped) {
        return (Vec::new(), 0);
    }

    // Find the line that contains the buttons + hint text
    let lines: Vec<&str> = ansi_text.lines().collect();
    let stripped_lines: Vec<String> = lines.iter().map(|l| strip_ansi(l)).collect();

    let mut button_line_idx = None;
    for (i, sl) in stripped_lines.iter().enumerate().rev() {
        let lower = sl.to_lowercase();
        if lower.contains("select") && lower.contains("confirm") {
            button_line_idx = Some(i);
            break;
        }
    }

    let Some(line_idx) = button_line_idx else {
        return (Vec::new(), 0);
    };

    let ansi_line = lines[line_idx];
    let clean_line = &stripped_lines[line_idx];

    // The button area ends before the first keyboard hint.
    // Find "ctrl+" which marks the start of keyboard hints.
    let button_area_end = clean_line
        .to_lowercase()
        .find("ctrl+")
        .unwrap_or(clean_line.len());
    let button_area = &clean_line[..button_area_end];

    // Extract button labels: non-empty trimmed words separated by 2+ spaces.
    // Skip the leading border character (┃ or similar).
    let content = button_area.trim_start_matches(|c: char| c.is_whitespace() || "┃│|".contains(c));
    let mut labels: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut space_run = 0;
    for ch in content.chars() {
        if ch == ' ' {
            space_run += 1;
            if space_run >= 2 && !current.is_empty() {
                labels.push(current.trim().to_string());
                current.clear();
            }
        } else {
            if space_run >= 1 && !current.is_empty() {
                current.push(' ');
            }
            space_run = 0;
            current.push(ch);
        }
    }
    if !current.trim().is_empty() {
        labels.push(current.trim().to_string());
    }

    // Filter out empty labels
    labels.retain(|l| !l.is_empty());

    if labels.is_empty() {
        return (Vec::new(), 0);
    }

    // Now determine column positions and selected state from the ANSI line.
    // Walk through the ANSI text, tracking display column and current background color.
    let selected_bg = "48;2;245;167;66"; // orange
    let mut options: Vec<QuestionOption> = Vec::new();

    for (idx, label) in labels.iter().enumerate() {
        // Find the column position of this label in the stripped line
        let col = find_label_column(
            clean_line,
            label,
            if idx > 0 {
                options
                    .last()
                    .map(|o| (o.col as usize) + options.last().map(|o| o.label.len()).unwrap_or(0))
                    .unwrap_or(0)
            } else {
                0
            },
        );

        // Check if this label's position in the ANSI line has the selected background
        let is_selected = is_label_highlighted(ansi_line, label, selected_bg);

        options.push(QuestionOption {
            number: idx.to_string(),
            label: label.clone(),
            selected: is_selected,
            col: col as u16,
        });
    }

    (options, line_idx as u16)
}

/// Find the display column of a label in a stripped line, starting search from `start_col`.
fn find_label_column(line: &str, label: &str, start_col: usize) -> usize {
    // Find the label text in the line after start_col
    if let Some(pos) = line[start_col..].find(label) {
        start_col + pos
    } else if let Some(pos) = line.find(label) {
        pos
    } else {
        0
    }
}

/// Check whether a label appears with a highlighted background in the ANSI line.
/// Walks the ANSI text looking for the label text and checking if the active
/// background color at that point matches the highlight color.
fn is_label_highlighted(ansi_line: &str, label: &str, highlight_bg: &str) -> bool {
    let mut current_bg = String::new();
    let mut visible_text = String::new();
    let mut chars = ansi_line.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                let mut seq = String::new();
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next.is_ascii_alphabetic() {
                        if next == 'm' {
                            // CSI m sequence - color codes
                            // Check for background color setting
                            if seq.contains(highlight_bg) {
                                current_bg = highlight_bg.to_string();
                            } else if seq.starts_with("48;") || seq == "0" || seq.is_empty() {
                                // Reset or different bg
                                if seq.contains("48;") && !seq.contains(highlight_bg) {
                                    current_bg.clear();
                                }
                                if seq == "0" || seq.is_empty() {
                                    current_bg.clear();
                                }
                            }
                        }
                        break;
                    }
                    seq.push(next);
                }
            } else {
                // Other ESC sequence
                chars.next();
            }
        } else {
            visible_text.push(c);
            // Check if visible_text ends with label and bg was highlighted
            if visible_text.ends_with(label) && current_bg == highlight_bg {
                return true;
            }
        }
    }
    false
}

/// Build a stable question_id from pane_id and sorted option labels.
fn make_question_id(pane_id: &str, options: &[QuestionOption]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for opt in options {
        opt.number.hash(&mut hasher);
        opt.label.hash(&mut hasher);
    }
    let hash = hasher.finish();
    format!("{}:{:x}", pane_id, hash)
}

/// Full cached question info for a pane, so we can re-send from cache on transient misses.
struct CachedQuestion {
    question: ClaudeQuestion,
    miss_count: u32,
}

/// Find the best affirmative option from a list of question options.
/// Prefers session/one-time approvals over persistent allowlist entries.
fn find_yes_option(options: &[QuestionOption]) -> Option<String> {
    const AFFIRMATIVE_PREFIXES: &[&str] = &[
        "yes", "allow", "approve", "proceed", "confirm", "ok", "okay",
    ];

    let mut best: Option<(&QuestionOption, i32)> = None;

    for opt in options {
        let lower = opt.label.to_lowercase();
        let trimmed = lower.trim_start_matches(|c: char| !c.is_alphanumeric());

        let has_affirmative_prefix = AFFIRMATIVE_PREFIXES.iter().any(|p| {
            trimmed
                .strip_prefix(p)
                .map(|rest| rest.is_empty() || !rest.starts_with(|c: char| c.is_alphanumeric()))
                .unwrap_or(false)
        });

        if !has_affirmative_prefix {
            continue;
        }

        let mut score = 100;

        if lower.contains("during this session") || lower.contains("this session") {
            score += 80;
        }
        if lower.contains(" once") || lower.starts_with("once ") || lower.contains(" this time") {
            score += 40;
        }
        if lower.contains("don't ask again")
            || lower.contains("do not ask again")
            || lower.contains("always")
            || lower.contains("all future")
            || lower.contains("remember")
            || lower.contains("for commands that start with")
        {
            score -= 70;
        }

        if score <= 0 {
            continue;
        }

        match best {
            Some((_, best_score)) if score <= best_score => {}
            _ => best = Some((opt, score)),
        }
    }

    best.map(|(opt, _)| opt.number.clone())
}

/// Runs the question detection loop. The idle path is intentionally conservative:
/// question detection is expensive because it scans tmux panes and captures output,
/// so we back off heavily when there are no active prompts to watch.
pub async fn question_detection_loop(
    settings: Arc<Mutex<AppSettings>>,
    jobs_config: Arc<Mutex<JobsConfig>>,
    job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    relay: Arc<Mutex<Option<RelayHandle>>>,
    active_questions: Arc<Mutex<Vec<ClaudeQuestion>>>,
    auto_yes_panes: Arc<Mutex<HashSet<String>>>,
    notifier: Arc<dyn crate::notifications::Notifier>,
    notification_state: Arc<Mutex<crate::notifications::NotificationState>>,
) {
    let mut question_cache: HashMap<String, CachedQuestion> = HashMap::new();
    let mut last_sent_ids: HashSet<String> = HashSet::new();
    let mut ticks_since_send: u32 = 0;
    let mut auto_answered_ids: HashMap<String, u32> = HashMap::new();
    let mut local_notifications_initialized = false;

    loop {
        let detection = detect_question_processes(&jobs_config, &job_status);
        let processes = detection.processes;
        log::debug!("[questions] detected {} claude processes", processes.len());

        prune_stale_auto_yes_panes(&auto_yes_panes, &detection.all_pane_ids);

        let detected_panes = update_question_cache(&processes, &mut question_cache);
        evict_stale_cache_entries(&mut question_cache, &detected_panes);

        let questions: Vec<ClaudeQuestion> = question_cache
            .values()
            .map(|c| c.question.clone())
            .collect();

        auto_answer_questions(&questions, &auto_yes_panes, &mut auto_answered_ids);
        retain_auto_answered_for_present(&questions, &mut auto_answered_ids);

        log::debug!("[questions] storing {} active questions", questions.len());
        *active_questions.lock() = questions.clone();

        let settings_snapshot = settings.lock().clone();
        let notifiable_questions = filter_visible_questions(&questions);

        if !local_notifications_initialized {
            crate::notifications::mark_questions_seen(&questions, &notification_state);
            local_notifications_initialized = true;
        } else if settings_snapshot.notify_questions_local {
            crate::notifications::notify_new_questions(
                notifier.as_ref(),
                &notifiable_questions,
                &questions,
                &notification_state,
                &auto_yes_panes,
            );
        } else {
            crate::notifications::mark_questions_seen(&questions, &notification_state);
        }

        let apns_questions = if settings_snapshot.notify_questions_remote {
            notifiable_questions
        } else {
            Vec::new()
        };
        send_relay_questions(
            questions.clone(),
            apns_questions,
            &auto_yes_panes,
            &relay,
            &mut last_sent_ids,
            &mut ticks_since_send,
        );

        let sleep_ms = pick_sleep_ms(&auto_yes_panes, &question_cache, &processes);
        tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
    }
}

fn filter_visible_questions(questions: &[ClaudeQuestion]) -> Vec<ClaudeQuestion> {
    questions
        .iter()
        .filter(|q| !should_suppress_question_notification(q))
        .cloned()
        .collect()
}

fn should_suppress_question_notification(question: &ClaudeQuestion) -> bool {
    if !is_user_active() {
        return false;
    }

    if is_clawtab_frontmost() {
        log::debug!(
            "[questions] suppressing notification for {} because ClawTab is frontmost",
            question.question_id
        );
        return true;
    }

    match crate::tmux::is_active_attached_pane(&question.pane_id) {
        Ok(true) => {
            log::debug!(
                "[questions] suppressing notification for {} because pane {} is active in tmux",
                question.question_id,
                question.pane_id
            );
            true
        }
        Ok(false) => false,
        Err(e) => {
            log::debug!(
                "[questions] tmux active-pane suppression check failed for {}: {}",
                question.pane_id,
                e
            );
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn is_clawtab_frontmost() -> bool {
    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            "tell application \"System Events\" to get bundle identifier of first application process whose frontmost is true",
        ])
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let bundle_id = String::from_utf8_lossy(&output.stdout);
    matches!(
        bundle_id.trim(),
        "cc.clawtab" | "cc.clawtab.engine" | "com.tonisives.clawtab"
    )
}

#[cfg(not(target_os = "macos"))]
fn is_clawtab_frontmost() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn is_user_active() -> bool {
    const ACTIVE_IDLE_SECONDS: u64 = 60;
    let output = std::process::Command::new("ioreg")
        .args(["-c", "IOHIDSystem"])
        .output();
    let Ok(output) = output else {
        return true;
    };
    if !output.status.success() {
        return true;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(raw) = stdout
        .lines()
        .find_map(|line| line.split("HIDIdleTime").nth(1))
        .and_then(|tail| tail.split('=').nth(1))
        .map(str::trim)
    else {
        return true;
    };
    let Ok(nanos) = raw.parse::<u64>() else {
        return true;
    };
    nanos / 1_000_000_000 < ACTIVE_IDLE_SECONDS
}

#[cfg(not(target_os = "macos"))]
fn is_user_active() -> bool {
    false
}

fn prune_stale_auto_yes_panes(
    auto_yes_panes: &Arc<Mutex<HashSet<String>>>,
    all_pane_ids: &HashSet<String>,
) {
    if all_pane_ids.is_empty() {
        return;
    }
    let mut yes_panes = auto_yes_panes.lock();
    let before = yes_panes.len();
    yes_panes.retain(|id| all_pane_ids.contains(id));
    if yes_panes.len() < before {
        log::info!(
            "[questions] pruned {} stale auto-yes pane(s)",
            before - yes_panes.len()
        );
    }
}

fn update_question_cache(
    processes: &[(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    )],
    question_cache: &mut HashMap<String, CachedQuestion>,
) -> HashSet<String> {
    let mut detected = HashSet::new();
    for (pane_id, cwd, tmux_session, window_name, log_lines, matched_group, matched_job) in
        processes
    {
        if try_numbered_question(
            pane_id,
            cwd,
            tmux_session,
            window_name,
            log_lines,
            matched_group,
            matched_job,
            &mut detected,
            question_cache,
        ) {
            continue;
        }
        try_opencode_question(
            pane_id,
            cwd,
            tmux_session,
            window_name,
            log_lines,
            matched_group,
            matched_job,
            &mut detected,
            question_cache,
        );
    }
    detected
}

#[allow(clippy::too_many_arguments)]
fn try_numbered_question(
    pane_id: &str,
    cwd: &str,
    tmux_session: &str,
    window_name: &str,
    log_lines: &str,
    matched_group: &Option<String>,
    matched_job: &Option<String>,
    detected: &mut HashSet<String>,
    cache: &mut HashMap<String, CachedQuestion>,
) -> bool {
    let options = parse_numbered_options(log_lines);
    if options.is_empty() {
        return false;
    }
    log::debug!(
        "[questions] pane {} ({}): {} numbered options",
        pane_id,
        cwd,
        options.len()
    );
    detected.insert(pane_id.to_string());
    let question_id = make_question_id(pane_id, &options);
    let q = ClaudeQuestion {
        pane_id: pane_id.to_string(),
        cwd: cwd.to_string(),
        tmux_session: tmux_session.to_string(),
        window_name: window_name.to_string(),
        question_id,
        context_lines: last_context_lines(log_lines),
        options,
        input_mode: String::new(),
        button_row: 0,
        matched_group: matched_group.clone(),
        matched_job: matched_job.clone(),
    };
    cache.insert(
        pane_id.to_string(),
        CachedQuestion {
            question: q,
            miss_count: 0,
        },
    );
    true
}

#[allow(clippy::too_many_arguments)]
fn try_opencode_question(
    pane_id: &str,
    cwd: &str,
    tmux_session: &str,
    window_name: &str,
    log_lines: &str,
    matched_group: &Option<String>,
    matched_job: &Option<String>,
    detected: &mut HashSet<String>,
    cache: &mut HashMap<String, CachedQuestion>,
) {
    let stripped_log = strip_ansi(log_lines);
    if !has_opencode_prompt_indicator(&stripped_log) {
        return;
    }
    let (full_text, _pane_height) = match crate::tmux::capture_pane_visible(pane_id) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[questions] failed to capture full pane {}: {}", pane_id, e);
            return;
        }
    };
    let (buttons, button_line_idx) = parse_opencode_buttons(&full_text);
    if buttons.is_empty() {
        return;
    }
    log::debug!(
        "[questions] pane {} ({}): {} opencode buttons at row {}",
        pane_id,
        cwd,
        buttons.len(),
        button_line_idx
    );
    detected.insert(pane_id.to_string());
    let question_id = make_question_id(pane_id, &buttons);
    let q = ClaudeQuestion {
        pane_id: pane_id.to_string(),
        cwd: cwd.to_string(),
        tmux_session: tmux_session.to_string(),
        window_name: window_name.to_string(),
        question_id,
        context_lines: last_context_lines(log_lines),
        options: buttons,
        input_mode: "select".to_string(),
        button_row: button_line_idx,
        matched_group: matched_group.clone(),
        matched_job: matched_job.clone(),
    };
    cache.insert(
        pane_id.to_string(),
        CachedQuestion {
            question: q,
            miss_count: 0,
        },
    );
}

fn evict_stale_cache_entries(
    cache: &mut HashMap<String, CachedQuestion>,
    detected: &HashSet<String>,
) {
    let stale_panes: Vec<String> = cache
        .keys()
        .filter(|p| !detected.contains(p.as_str()))
        .cloned()
        .collect();
    for pane_id in stale_panes {
        let entry = cache.get_mut(&pane_id).unwrap();
        entry.miss_count += 1;
        if entry.miss_count >= 5 {
            cache.remove(&pane_id);
        }
    }
}

fn auto_answer_questions(
    questions: &[ClaudeQuestion],
    auto_yes_panes: &Arc<Mutex<HashSet<String>>>,
    auto_answered_ids: &mut HashMap<String, u32>,
) {
    let yes_panes = auto_yes_panes.lock().clone();
    if yes_panes.is_empty() {
        return;
    }
    log::debug!(
        "[questions] auto-yes panes: {:?}, questions: {}",
        yes_panes,
        questions.len()
    );
    for q in questions {
        if !yes_panes.contains(&q.pane_id) {
            log::debug!(
                "[questions] pane {} not in auto-yes set, skipping",
                q.pane_id
            );
            continue;
        }
        if let Some(ticks) = auto_answered_ids.get(&q.question_id) {
            if *ticks < 6 {
                log::debug!(
                    "[questions] question {} already auto-answered ({} ticks ago), skipping",
                    q.question_id,
                    ticks
                );
                continue;
            }
            log::debug!(
                "[questions] question {} still present after {} ticks, retrying auto-answer",
                q.question_id,
                ticks
            );
        }
        try_send_auto_answer(q, auto_answered_ids);
    }
}

fn try_send_auto_answer(q: &ClaudeQuestion, auto_answered_ids: &mut HashMap<String, u32>) {
    let options_summary: Vec<String> = q
        .options
        .iter()
        .map(|o| format!("{}={}", o.number, o.label))
        .collect();
    log::debug!(
        "[questions] checking auto-yes for pane {} question {} options: {:?}",
        q.pane_id,
        q.question_id,
        options_summary
    );
    let Some(opt) = find_yes_option(&q.options) else {
        log::warn!(
            "[questions] no yes option found for pane {} question {}, options: {:?}",
            q.pane_id,
            q.question_id,
            options_summary
        );
        return;
    };
    log::info!(
        "[questions] auto-answering pane {} question {} with option {}",
        q.pane_id,
        q.question_id,
        opt
    );
    let send_result = if q.input_mode == "select" {
        if let Some(target_opt) = q.options.iter().find(|o| o.number == opt) {
            crate::tmux::send_mouse_click_to_pane(&q.pane_id, target_opt.col, q.button_row)
        } else {
            Err("option not found".to_string())
        }
    } else {
        crate::tmux::send_keys_to_tui_pane(&q.pane_id, &opt)
    };
    match send_result {
        Ok(()) => {
            auto_answered_ids.insert(q.question_id.clone(), 0);
        }
        Err(e) => {
            log::error!("[questions] auto-answer send_keys failed: {}", e);
        }
    }
}

fn retain_auto_answered_for_present(
    questions: &[ClaudeQuestion],
    auto_answered_ids: &mut HashMap<String, u32>,
) {
    let current_qids: HashSet<String> = questions.iter().map(|q| q.question_id.clone()).collect();
    auto_answered_ids.retain(|id, ticks| {
        if !current_qids.contains(id) {
            return false;
        }
        *ticks += 1;
        true
    });
}

fn send_relay_questions(
    questions: Vec<ClaudeQuestion>,
    apns_questions: Vec<ClaudeQuestion>,
    auto_yes_panes: &Arc<Mutex<HashSet<String>>>,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
    last_sent_ids: &mut HashSet<String>,
    ticks_since_send: &mut u32,
) {
    let relay_questions: Vec<ClaudeQuestion> = {
        let yes_panes = auto_yes_panes.lock();
        questions
            .into_iter()
            .filter(|q| !yes_panes.contains(&q.pane_id))
            .collect()
    };
    let apns_questions: Vec<ClaudeQuestion> = {
        let yes_panes = auto_yes_panes.lock();
        apns_questions
            .into_iter()
            .filter(|q| !yes_panes.contains(&q.pane_id))
            .collect()
    };
    let current_ids: HashSet<String> = relay_questions
        .iter()
        .map(|q| q.question_id.clone())
        .collect();
    *ticks_since_send += 1;
    let changed = current_ids != *last_sent_ids;
    let periodic_resend = !relay_questions.is_empty() && *ticks_since_send >= 2;
    if !changed && !periodic_resend {
        return;
    }
    *last_sent_ids = current_ids;
    *ticks_since_send = 0;
    let msg = clawtab_protocol::DesktopMessage::ClaudeQuestions {
        questions: relay_questions,
        apns_questions: Some(apns_questions),
    };
    let guard = relay.lock();
    if let Some(handle) = guard.as_ref() {
        handle.send_message(&msg);
    }
}

fn pick_sleep_ms(
    auto_yes_panes: &Arc<Mutex<HashSet<String>>>,
    question_cache: &HashMap<String, CachedQuestion>,
    processes: &[(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    )],
) -> u64 {
    let has_auto_yes = !auto_yes_panes.lock().is_empty();
    if has_auto_yes {
        750
    } else if !question_cache.is_empty() {
        2000
    } else if !processes.is_empty() {
        10000
    } else {
        15000
    }
}

/// Extract the last visible lines from terminal output for the notification card.
/// Includes numbered options and their descriptions so the card mirrors the terminal.
/// Only strips interactive instruction lines (e.g. "Enter to select").
fn last_context_lines(text: &str) -> String {
    let clean = strip_ansi(text);
    let lines: Vec<&str> = clean.lines().collect();
    let tail = if lines.len() > 30 {
        &lines[lines.len() - 30..]
    } else {
        &lines
    };
    let mut context = Vec::new();
    for line in tail {
        let lower = line.trim().to_lowercase();
        // Skip interactive prompt instruction lines
        if lower.contains("enter to select")
            || lower.contains("to navigate")
            || lower.contains("esc to cancel")
        {
            continue;
        }
        // Skip opencode button/hint lines
        if lower.contains("enter confirm") {
            continue;
        }
        context.push(*line);
    }
    // Trim leading/trailing empty lines
    while context.first().map_or(false, |l| l.trim().is_empty()) {
        context.remove(0);
    }
    while context.last().map_or(false, |l| l.trim().is_empty()) {
        context.pop();
    }
    context.join("\n")
}

struct DetectionResult {
    processes: Vec<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    )>,
    /// All pane IDs that currently exist in tmux (not just Claude processes).
    all_pane_ids: HashSet<String>,
}

fn detect_questions_is_view_session(name: &str) -> bool {
    name.starts_with("clawtab-") && name.contains("-view-")
}

const DETECT_QUESTIONS_SEP: &str = "|||";

fn list_panes_for_questions() -> Option<String> {
    use std::process::Command;
    let format_str = format!(
        "#{{pane_id}}{0}#{{pane_current_command}}{0}#{{pane_current_path}}{0}#{{session_name}}{0}#{{window_name}}{0}#{{pane_pid}}",
        DETECT_QUESTIONS_SEP
    );
    match Command::new("tmux")
        .args(["list-panes", "-a", "-F", &format_str])
        .output()
    {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).to_string()),
        _ => None,
    }
}

fn collect_q_running_panes(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> HashMap<String, (String, String)> {
    let statuses = job_status.lock();
    let config = jobs_config.lock();
    statuses
        .iter()
        .filter_map(|(slug, s)| {
            if let JobStatus::Running {
                pane_id: Some(pid), ..
            } = s
            {
                let job = config.jobs.iter().find(|j| j.slug == *slug);
                let group = job.map(|j| j.group.clone());
                Some((pid.clone(), (slug.clone(), group.unwrap_or_default())))
            } else {
                None
            }
        })
        .collect()
}

fn collect_q_match_entries(jobs_config: &Arc<Mutex<JobsConfig>>) -> Vec<(String, String, String)> {
    let config = jobs_config.lock();
    config
        .jobs
        .iter()
        .filter_map(|job| {
            if let Some(ref fp) = job.folder_path {
                Some((fp.clone(), job.group.clone(), job.slug.clone()))
            } else {
                job.work_dir
                    .as_ref()
                    .map(|wd| (wd.clone(), job.group.clone(), job.slug.clone()))
            }
        })
        .collect()
}

fn resolve_q_group_job(
    pane_id: &str,
    cwd: &str,
    running_panes: &HashMap<String, (String, String)>,
    match_entries: &[(String, String, String)],
) -> (Option<String>, Option<String>) {
    if let Some((job_id, group)) = running_panes.get(pane_id) {
        return (Some(group.clone()), Some(job_id.clone()));
    }
    for (root, group, _name) in match_entries {
        if cwd == root || cwd.starts_with(&format!("{}/", root)) {
            return (Some(group.clone()), None);
        }
    }
    (None, None)
}

/// Detect Claude processes and return their details for question parsing.
fn detect_question_processes(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> DetectionResult {
    let process_snapshot = ProcessSnapshot::capture();
    let Some(stdout) = list_panes_for_questions() else {
        return DetectionResult {
            processes: vec![],
            all_pane_ids: HashSet::new(),
        };
    };

    let running_panes = collect_q_running_panes(jobs_config, job_status);
    let match_entries = collect_q_match_entries(jobs_config);

    let mut all_pane_ids = HashSet::new();
    let mut seen = HashSet::new();
    let mut results = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(6, DETECT_QUESTIONS_SEP).collect();
        if parts.len() < 6 {
            continue;
        }
        let (pane_id, _command, cwd, session, window, pane_pid) =
            (parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);

        all_pane_ids.insert(pane_id.to_string());
        if detect_questions_is_view_session(session) {
            continue;
        }

        let provider = detect_process_provider(pane_pid, Some(&process_snapshot));
        if provider.is_none() {
            continue;
        }
        log::debug!(
            "[questions] pane {} pid {} detected as {:?}",
            pane_id,
            pane_pid,
            provider
        );

        if !seen.insert(pane_id.to_string()) {
            continue;
        }

        let (matched_group, matched_job) =
            resolve_q_group_job(pane_id, cwd, &running_panes, &match_entries);

        let log_lines = crate::tmux::capture_pane(session, pane_id, 16)
            .unwrap_or_default()
            .trim()
            .to_string();

        results.push((
            pane_id.to_string(),
            cwd.to_string(),
            session.to_string(),
            window.to_string(),
            log_lines,
            matched_group,
            matched_job,
        ));
    }

    DetectionResult {
        processes: results,
        all_pane_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::{find_yes_option, parse_numbered_options, parse_opencode_buttons};
    use clawtab_protocol::QuestionOption;

    #[test]
    fn parses_claude_style_numbered_prompt() {
        let text = r#"
Would you like to continue?

› 1. Yes
  2. No

Enter to select · Esc to cancel
"#;

        let options = parse_numbered_options(text);
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].number, "1");
        assert_eq!(options[0].label, "Yes");
        assert_eq!(options[1].number, "2");
        assert_eq!(options[1].label, "No");
    }

    #[test]
    fn parses_codex_command_approval_prompt() {
        let text = r#"
Would you like to run the following command?
Reason: Do you want me to verify whether Slack's careers page is backed by Greenhouse
$ curl -s https://boards-api.greenhouse.io/v1/boards/slack/jobs | sed -n '1,40p'
› 1. Yes, proceed (y)
2. Yes, and don't ask again for commands that start with 'curl -s https://boards-api.greenhouse.io/v1/boards/slack/jobs' (p)
3. No, and tell Codex what to do differently
"#;

        let options = parse_numbered_options(text);
        assert_eq!(options.len(), 3);
        assert_eq!(options[0].number, "1");
        assert_eq!(options[0].label, "Yes, proceed (y)");
        assert_eq!(options[1].number, "2");
        assert_eq!(options[2].number, "3");
    }

    #[test]
    fn ignores_plain_numbered_lists_without_prompt_signal() {
        let text = r#"
Plan:
1. Inspect the parser
2. Patch the filter
3. Run tests
"#;

        let options = parse_numbered_options(text);
        assert!(options.is_empty());
    }

    #[test]
    fn prefers_session_scoped_yes_over_broader_yes() {
        let options = vec![
            QuestionOption {
                number: "1".to_string(),
                label: "Yes".to_string(),
                selected: false,
                col: 0,
            },
            QuestionOption {
                number: "2".to_string(),
                label: "Yes, during this session".to_string(),
                selected: false,
                col: 0,
            },
            QuestionOption {
                number: "3".to_string(),
                label: "No".to_string(),
                selected: false,
                col: 0,
            },
        ];

        assert_eq!(find_yes_option(&options), Some("2".to_string()));
    }

    #[test]
    fn prefers_one_time_codex_approval_over_persistent_allowlist() {
        let options = vec![
            QuestionOption {
                number: "1".to_string(),
                label: "Approve once".to_string(),
                selected: false,
                col: 0,
            },
            QuestionOption {
                number: "2".to_string(),
                label: "Always allow commands that start with 'npm test'".to_string(),
                selected: false,
                col: 0,
            },
            QuestionOption {
                number: "3".to_string(),
                label: "Tell Codex what to do differently".to_string(),
                selected: false,
                col: 0,
            },
        ];

        assert_eq!(find_yes_option(&options), Some("1".to_string()));
    }

    #[test]
    fn parses_opencode_select_buttons() {
        // Simulated opencode ANSI output with "Allow once", "Allow always" (selected), "Reject"
        let ansi_text = concat!(
            "  \x1b[38;2;245;167;66m\x1b[48;2;20;20;20m\u{2503}\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m",
            "   \x1b[38;2;128;128;128mAllow once\x1b[38;2;255;255;255m  ",
            "\x1b[48;2;245;167;66m \x1b[38;2;10;10;10mAllow always\x1b[38;2;255;255;255m ",
            "\x1b[48;2;30;30;30m  \x1b[38;2;128;128;128mReject\x1b[38;2;255;255;255m",
            "   ctrl+f fullscreen  \u{21C6} select  enter confirm\n",
        );

        let (options, _row) = parse_opencode_buttons(ansi_text);
        assert_eq!(options.len(), 3);
        assert_eq!(options[0].label, "Allow once");
        assert_eq!(options[1].label, "Allow always");
        assert_eq!(options[2].label, "Reject");
        // "Allow always" should be selected (has orange bg)
        assert!(options[1].selected, "Allow always should be highlighted");
        assert!(!options[0].selected, "Allow once should not be highlighted");
        assert!(!options[2].selected, "Reject should not be highlighted");
    }

    #[test]
    fn opencode_find_yes_prefers_allow_once() {
        let options = vec![
            QuestionOption {
                number: "0".to_string(),
                label: "Allow once".to_string(),
                selected: false,
                col: 0,
            },
            QuestionOption {
                number: "1".to_string(),
                label: "Allow always".to_string(),
                selected: false,
                col: 0,
            },
            QuestionOption {
                number: "2".to_string(),
                label: "Reject".to_string(),
                selected: false,
                col: 0,
            },
        ];

        // "Allow once" should win: "allow" gets 60, "once" gets 40 = 100
        // "Allow always" gets: "allow" 60, "always" -70 = -10 (filtered out)
        assert_eq!(find_yes_option(&options), Some("0".to_string()));
    }

    #[test]
    fn ignores_non_opencode_text_with_select_and_confirm() {
        // Plain text that happens to mention "select" and "confirm" shouldn't trigger detection
        let text = "Please select an item and confirm your choice.\n";
        let (options, _) = parse_opencode_buttons(text);
        assert!(options.is_empty());
    }

    #[test]
    fn rejects_destructive_options_without_affirmative_prefix() {
        let options = vec![
            QuestionOption {
                number: "1".to_string(),
                label: "Revert and pin to the PR fork (Recommended)".to_string(),
                selected: false,
                col: 0,
            },
            QuestionOption {
                number: "2".to_string(),
                label: "Revert and re-apply via lazy config hook".to_string(),
                selected: false,
                col: 0,
            },
            QuestionOption {
                number: "3".to_string(),
                label: "Just discard local changes for now".to_string(),
                selected: false,
                col: 0,
            },
            QuestionOption {
                number: "4".to_string(),
                label: "Type something.".to_string(),
                selected: false,
                col: 0,
            },
        ];

        assert_eq!(find_yes_option(&options), None);
    }
}
