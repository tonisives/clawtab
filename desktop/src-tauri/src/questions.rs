use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use clawtab_protocol::{ClaudeQuestion, QuestionOption};

use crate::claude_session::{detect_process_provider, ProcessSnapshot};
use crate::config::jobs::{JobStatus, JobsConfig};
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

/// Find the best "yes" option from a list of question options.
/// Prefers "Yes, during this session" over plain "Yes".
fn find_yes_option(options: &[QuestionOption]) -> Option<String> {
    // Prefer "Yes, during this session" or similar session-scoped option
    for opt in options {
        if opt.label.to_lowercase().contains("yes") && opt.label.to_lowercase().contains("session")
        {
            return Some(opt.number.clone());
        }
    }
    // Fall back to plain "Yes"
    for opt in options {
        if opt.label.to_lowercase().starts_with("yes") {
            return Some(opt.number.clone());
        }
    }
    None
}

/// Runs the question detection loop. The idle path is intentionally conservative:
/// question detection is expensive because it scans tmux panes and captures output,
/// so we back off heavily when there are no active prompts to watch.
pub async fn question_detection_loop(
    jobs_config: Arc<Mutex<JobsConfig>>,
    job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    relay: Arc<Mutex<Option<RelayHandle>>>,
    active_questions: Arc<Mutex<Vec<ClaudeQuestion>>>,
    auto_yes_panes: Arc<Mutex<HashSet<String>>>,
    app_handle: tauri::AppHandle,
    notification_state: Arc<Mutex<crate::notifications::NotificationState>>,
) {
    // Cache full question data per pane so transient detection misses don't flicker
    let mut question_cache: HashMap<String, CachedQuestion> = HashMap::new();
    // Track which question IDs we last sent to relay, so we only push on changes
    let mut last_sent_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Re-send unchanged questions periodically so newly connected clients get them
    let mut ticks_since_send: u32 = 0;
    // Track which question IDs have been auto-answered, with tick count for retry
    let mut auto_answered_ids: HashMap<String, u32> = HashMap::new();

    loop {
        let detection = detect_question_processes(&jobs_config, &job_status);
        let processes = detection.processes;
        log::debug!("[questions] detected {} claude processes", processes.len());

        // Prune auto_yes_panes: remove pane IDs where the pane no longer exists.
        // Keep panes that exist but don't have a Claude process yet (startup delay)
        // so that auto-yes isn't lost between pane creation and Claude launch.
        if !detection.all_pane_ids.is_empty() {
            let mut yes_panes = auto_yes_panes.lock().unwrap();
            let before = yes_panes.len();
            yes_panes.retain(|id| detection.all_pane_ids.contains(id));
            if yes_panes.len() < before {
                log::info!(
                    "[questions] pruned {} stale auto-yes pane(s)",
                    before - yes_panes.len()
                );
            }
        }

        // Track which panes were detected this tick
        let mut detected_panes = std::collections::HashSet::new();

        for (pane_id, cwd, tmux_session, window_name, log_lines, matched_group, matched_job) in
            &processes
        {
            let options = parse_numbered_options(log_lines);
            if options.is_empty() {
                continue;
            }
            log::debug!(
                "[questions] pane {} ({}): {} options",
                pane_id,
                cwd,
                options.len()
            );

            detected_panes.insert(pane_id.clone());

            let question_id = make_question_id(pane_id, &options);

            let q = ClaudeQuestion {
                pane_id: pane_id.clone(),
                cwd: cwd.clone(),
                tmux_session: tmux_session.clone(),
                window_name: window_name.clone(),
                question_id,
                context_lines: last_context_lines(log_lines),
                options,
                matched_group: matched_group.clone(),
                matched_job: matched_job.clone(),
            };

            question_cache.insert(
                pane_id.clone(),
                CachedQuestion {
                    question: q,
                    miss_count: 0,
                },
            );
        }

        // For panes not detected this tick, increment miss count or remove
        let stale_panes: Vec<String> = question_cache
            .keys()
            .filter(|p| !detected_panes.contains(p.as_str()))
            .cloned()
            .collect();
        for pane_id in stale_panes {
            let entry = question_cache.get_mut(&pane_id).unwrap();
            entry.miss_count += 1;
            // After 5 consecutive misses (10s), consider the question truly gone
            if entry.miss_count >= 5 {
                question_cache.remove(&pane_id);
            }
        }

        // Build final question list from cache (includes grace-period entries)
        let questions: Vec<ClaudeQuestion> = question_cache
            .values()
            .map(|c| c.question.clone())
            .collect();

        // Auto-answer questions for panes with auto-yes enabled
        {
            let yes_panes = auto_yes_panes.lock().unwrap().clone();
            if !yes_panes.is_empty() {
                log::debug!(
                    "[questions] auto-yes panes: {:?}, questions: {}",
                    yes_panes,
                    questions.len()
                );
                for q in &questions {
                    if !yes_panes.contains(&q.pane_id) {
                        log::debug!(
                            "[questions] pane {} not in auto-yes set, skipping",
                            q.pane_id
                        );
                        continue;
                    }
                    if let Some(ticks) = auto_answered_ids.get(&q.question_id) {
                        // Retry after 6 ticks (3s) if the question is still present
                        if *ticks < 6 {
                            log::debug!("[questions] question {} already auto-answered ({} ticks ago), skipping", q.question_id, ticks);
                            continue;
                        }
                        log::debug!("[questions] question {} still present after {} ticks, retrying auto-answer", q.question_id, ticks);
                    }
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
                    if let Some(opt) = find_yes_option(&q.options) {
                        log::info!(
                            "[questions] auto-answering pane {} question {} with option {}",
                            q.pane_id,
                            q.question_id,
                            opt
                        );
                        match crate::tmux::send_keys_to_tui_pane(&q.pane_id, &opt) {
                            Ok(()) => {
                                auto_answered_ids.insert(q.question_id.clone(), 0);
                            }
                            Err(e) => {
                                log::error!("[questions] auto-answer send_keys failed: {}", e);
                                // Don't mark as answered so it retries next tick
                            }
                        }
                    } else {
                        log::warn!("[questions] no yes option found for pane {} question {}, options: {:?}", q.pane_id, q.question_id, options_summary);
                    }
                }
            }
        }

        // Increment tick counts for auto-answered questions still present, remove stale
        let current_qids: HashSet<String> =
            questions.iter().map(|q| q.question_id.clone()).collect();
        auto_answered_ids.retain(|id, ticks| {
            if !current_qids.contains(id) {
                return false;
            }
            *ticks += 1;
            true
        });

        // Store for desktop frontend
        log::debug!("[questions] storing {} active questions", questions.len());
        *active_questions.lock().unwrap() = questions.clone();

        // Fire local macOS notifications for new questions
        crate::notifications::notify_new_questions(
            &app_handle,
            &questions,
            &notification_state,
            &auto_yes_panes,
        );

        // Filter out auto-yes panes before sending to relay - no need to notify
        // mobile about questions that will be auto-answered locally
        let relay_questions: Vec<ClaudeQuestion> = {
            let yes_panes = auto_yes_panes.lock().unwrap();
            questions
                .into_iter()
                .filter(|q| !yes_panes.contains(&q.pane_id))
                .collect()
        };

        // Send to relay when questions change, or periodically (every 6 ticks = 30s)
        // so newly connected clients get them without waiting for a change
        let current_ids: std::collections::HashSet<String> = relay_questions
            .iter()
            .map(|q| q.question_id.clone())
            .collect();
        ticks_since_send += 1;
        let changed = current_ids != last_sent_ids;
        let periodic_resend = !relay_questions.is_empty() && ticks_since_send >= 2;
        if changed || periodic_resend {
            last_sent_ids = current_ids;
            ticks_since_send = 0;
            let msg = clawtab_protocol::DesktopMessage::ClaudeQuestions {
                questions: relay_questions,
            };
            if let Ok(guard) = relay.lock() {
                if let Some(handle) = guard.as_ref() {
                    handle.send_message(&msg);
                }
            }
        }

        // Question detection is one of the main steady-state CPU costs in the app.
        // Keep it responsive when we have active prompts, but back off when idle.
        let has_auto_yes = !auto_yes_panes.lock().unwrap().is_empty();
        let sleep_ms = if has_auto_yes {
            750
        } else if !question_cache.is_empty() {
            2000
        } else if !processes.is_empty() {
            10000
        } else {
            15000
        };
        tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
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

/// Detect Claude processes and return their details for question parsing.
fn detect_question_processes(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> DetectionResult {
    use std::collections::HashSet;
    use std::process::Command;
    let process_snapshot = ProcessSnapshot::capture();

    let output = match Command::new("tmux")
        .args([
            "list-panes", "-a", "-F",
            "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}\t#{window_name}\t#{pane_pid}",
        ])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return DetectionResult { processes: vec![], all_pane_ids: HashSet::new() },
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Also include tracked running panes (jobs with pane_id) for question detection
    let running_panes: HashMap<String, (String, String)> = {
        let statuses = job_status.lock().unwrap();
        let config = jobs_config.lock().unwrap();
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
    };

    let match_entries: Vec<(String, String, String)> = {
        let config = jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .filter_map(|job| {
                if let Some(ref fp) = job.folder_path {
                    Some((fp.clone(), job.group.clone(), job.slug.clone()))
                } else if let Some(ref wd) = job.work_dir {
                    Some((wd.clone(), job.group.clone(), job.slug.clone()))
                } else {
                    None
                }
            })
            .collect()
    };

    let mut all_pane_ids = HashSet::new();
    let mut seen = HashSet::new();
    let mut results = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(6, '\t').collect();
        if parts.len() < 6 {
            continue;
        }

        let (pane_id, _command, cwd, session, window, pane_pid) =
            (parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);

        all_pane_ids.insert(pane_id.to_string());

        if detect_process_provider(pane_pid, Some(&process_snapshot)).is_none() {
            continue;
        }

        if !seen.insert(pane_id.to_string()) {
            continue;
        }

        // Check if this is a tracked running job
        let (matched_group, matched_job) =
            if let Some((job_name, group)) = running_panes.get(pane_id) {
                (Some(group.clone()), Some(job_name.clone()))
            } else {
                // Try to match against configured job folders
                let mut mg = None;
                for (root, group, _name) in &match_entries {
                    if cwd == root || cwd.starts_with(&format!("{}/", root)) {
                        mg = Some(group.clone());
                        break;
                    }
                }
                (mg, None)
            };

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
    use super::parse_numbered_options;

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
}
