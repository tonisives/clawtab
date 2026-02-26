use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use clawtab_protocol::{ClaudeQuestion, QuestionOption};

use crate::config::jobs::{JobStatus, JobsConfig};
use crate::relay::RelayHandle;

/// Parse numbered options from Claude output text.
/// Matches lines like "1. Fix the bug" or "  > 2. Skip this step"
/// Only returns options if the output looks like an interactive prompt
/// (contains prompt indicators like "Enter to select", arrow navigation hints, etc.)
pub fn parse_numbered_options(text: &str) -> Vec<QuestionOption> {
    let lines: Vec<&str> = text.lines().collect();
    let tail = if lines.len() > 20 { &lines[lines.len() - 20..] } else { &lines };
    let mut options = Vec::new();
    for line in tail {
        // Match optional leading whitespace/prompt chars, then digit(s).label
        // Include Unicode prompt indicators: › (U+203A), » (U+00BB), ❯ (U+276F), ▸ (U+25B8), ▶ (U+25B6)
        let trimmed = line.trim_start_matches(|c: char| c.is_whitespace() || ">~`|›»❯▸▶".contains(c));
        if let Some(rest) = trimmed.strip_prefix(|c: char| c.is_ascii_digit()) {
            // Could be multi-digit, find the dot
            let digit_end = rest.find(". ");
            if let Some(dot_pos) = digit_end {
                let number_str = &trimmed[..trimmed.len() - rest.len() + dot_pos];
                // Verify it's all digits
                if number_str.chars().all(|c| c.is_ascii_digit()) {
                    let label = rest[dot_pos + 2..].trim().to_string();
                    if !label.is_empty() {
                        options.push(QuestionOption {
                            number: number_str.to_string(),
                            label,
                        });
                    }
                }
            }
        }
    }

    if options.is_empty() {
        return options;
    }

    // Verify that the output looks like an interactive prompt, not just numbered text.
    // Claude's interactive menus include instructional text like "Enter to select",
    // navigation hints, or the prompt cursor character.
    if !has_interactive_prompt_indicator(text) {
        return Vec::new();
    }

    options
}

/// Check whether the terminal output contains indicators of an interactive prompt.
/// Claude CLI's interactive menus always include instructional text like
/// "Enter to select . ↑/↓ to navigate . Esc to cancel"
/// We only check the LAST few lines so stale prompt text higher up doesn't trigger.
fn has_interactive_prompt_indicator(text: &str) -> bool {
    // Check only the last 5 lines for prompt indicators to avoid stale matches
    let tail: String = text.lines().rev().take(5).collect::<Vec<_>>().join("\n").to_lowercase();
    tail.contains("enter to select")
        || tail.contains("to navigate")
        || tail.contains("esc to cancel")
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

/// Previous question state per pane.
type QuestionState = HashMap<String, Vec<QuestionOption>>;

/// Full cached question info for a pane, so we can re-send from cache on transient misses.
struct CachedQuestion {
    question: ClaudeQuestion,
    miss_count: u32,
}

/// Runs the question detection loop. Checks every 5 seconds for Claude processes
/// that have interactive numbered options, and sends them to the relay.
pub async fn question_detection_loop(
    jobs_config: Arc<Mutex<JobsConfig>>,
    job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    relay: Arc<Mutex<Option<RelayHandle>>>,
    active_questions: Arc<Mutex<QuestionState>>,
) {
    // Cache full question data per pane so transient detection misses don't flicker
    let mut question_cache: HashMap<String, CachedQuestion> = HashMap::new();

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        // Only run if relay is connected
        let has_relay = relay.lock().unwrap().is_some();
        if !has_relay {
            continue;
        }

        let processes = detect_question_processes(&jobs_config, &job_status);

        // Track which panes were detected this tick
        let mut detected_panes = std::collections::HashSet::new();
        let mut new_state = HashMap::new();

        for (pane_id, cwd, tmux_session, window_name, log_lines, matched_group, matched_job) in &processes {
            let options = parse_numbered_options(log_lines);
            if options.is_empty() {
                continue;
            }

            detected_panes.insert(pane_id.clone());

            let question_id = make_question_id(pane_id, &options);
            new_state.insert(pane_id.clone(), options.clone());

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

            question_cache.insert(pane_id.clone(), CachedQuestion {
                question: q,
                miss_count: 0,
            });
        }

        // For panes not detected this tick, increment miss count or remove
        let stale_panes: Vec<String> = question_cache.keys()
            .filter(|p| !detected_panes.contains(p.as_str()))
            .cloned()
            .collect();
        for pane_id in stale_panes {
            let entry = question_cache.get_mut(&pane_id).unwrap();
            entry.miss_count += 1;
            // After 3 consecutive misses (15s), consider the question truly gone
            if entry.miss_count >= 3 {
                question_cache.remove(&pane_id);
            }
        }

        // Build final question list from cache (includes grace-period entries)
        let questions: Vec<ClaudeQuestion> = question_cache.values()
            .map(|c| c.question.clone())
            .collect();

        *active_questions.lock().unwrap() = new_state;

        // Always send current questions so mobile stays in sync after reconnects
        let msg = clawtab_protocol::DesktopMessage::ClaudeQuestions { questions };
        if let Ok(guard) = relay.lock() {
            if let Some(handle) = guard.as_ref() {
                handle.send_message(&msg);
            }
        }
    }
}

/// Extract last few non-empty context lines before the options.
fn last_context_lines(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut context = Vec::new();
    for line in lines.iter().rev() {
        let trimmed = line.trim();
        // Skip option lines
        let stripped = trimmed.trim_start_matches(|c: char| c.is_whitespace() || ">~`|›»❯▸▶".contains(c));
        if stripped.starts_with(|c: char| c.is_ascii_digit()) && stripped.contains(". ") {
            continue;
        }
        if !trimmed.is_empty() {
            context.push(*line);
            if context.len() >= 3 {
                break;
            }
        }
    }
    context.reverse();
    context.join("\n")
}

/// Detect Claude processes and return their details for question parsing.
/// Returns: Vec<(pane_id, cwd, tmux_session, window_name, log_lines, matched_group, matched_job)>
fn detect_question_processes(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Vec<(String, String, String, String, String, Option<String>, Option<String>)> {
    use std::collections::HashSet;
    use std::process::Command;

    fn is_semver(s: &str) -> bool {
        let parts: Vec<&str> = s.split('.').collect();
        parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    }

    let output = match Command::new("tmux")
        .args([
            "list-panes", "-a", "-F",
            "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}\t#{window_name}",
        ])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Also include tracked running panes (jobs with pane_id) for question detection
    let running_panes: HashMap<String, (String, String)> = {
        let statuses = job_status.lock().unwrap();
        let config = jobs_config.lock().unwrap();
        statuses.iter().filter_map(|(name, s)| {
            if let JobStatus::Running { pane_id: Some(pid), .. } = s {
                let job = config.jobs.iter().find(|j| j.name == *name);
                let group = job.map(|j| j.group.clone());
                Some((pid.clone(), (name.clone(), group.unwrap_or_default())))
            } else {
                None
            }
        }).collect()
    };

    let match_entries: Vec<(String, String, String)> = {
        let config = jobs_config.lock().unwrap();
        config.jobs.iter().filter_map(|job| {
            if let Some(ref fp) = job.folder_path {
                let root = fp.strip_suffix("/.cwt").unwrap_or(fp);
                Some((root.to_string(), job.group.clone(), job.name.clone()))
            } else if let Some(ref wd) = job.work_dir {
                Some((wd.clone(), job.group.clone(), job.name.clone()))
            } else {
                None
            }
        }).collect()
    };

    let mut seen = HashSet::new();
    let mut results = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(5, '\t').collect();
        if parts.len() < 5 { continue; }

        let (pane_id, command, cwd, session, window) =
            (parts[0], parts[1], parts[2], parts[3], parts[4]);

        if !is_semver(command) { continue; }
        if !seen.insert(pane_id.to_string()) { continue; }

        // Check if this is a tracked running job
        let (matched_group, matched_job) = if let Some((job_name, group)) = running_panes.get(pane_id) {
            (Some(group.clone()), Some(job_name.clone()))
        } else {
            // Try to match against configured job folders
            let mut mg = None;
            let mut mj = None;
            for (root, group, name) in &match_entries {
                if cwd == root || cwd.starts_with(&format!("{}/", root)) {
                    mg = Some(group.clone());
                    mj = Some(name.clone());
                    break;
                }
            }
            (mg, mj)
        };

        let log_lines = crate::tmux::capture_pane(session, pane_id, 20)
            .unwrap_or_default().trim().to_string();

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

    results
}
