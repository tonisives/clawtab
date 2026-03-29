use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use clawtab_protocol::ClaudeQuestion;
use tauri_plugin_notification::NotificationExt;

/// Deduplication state for question notifications.
pub struct NotificationState {
    notified_question_ids: HashSet<String>,
}

impl NotificationState {
    pub fn new() -> Self {
        Self {
            notified_question_ids: HashSet::new(),
        }
    }
}

/// Compact a cwd path for use as a notification title.
/// Keeps the last 2 segments in full, abbreviates earlier ones to first char.
/// e.g. "/Users/tonis/workspace/tgs/clawtab/public" -> "~/w/t/clawtab/public"
fn compact_cwd(cwd: &str) -> String {
    let path = cwd
        .strip_prefix("/Users/")
        .or_else(|| cwd.strip_prefix("/home/"));
    let segments: Vec<&str> = match path {
        Some(rest) => {
            let parts: Vec<&str> = rest.splitn(2, '/').collect();
            if parts.len() < 2 {
                return cwd.rsplit('/').next().unwrap_or(cwd).to_string();
            }
            parts[1].split('/').filter(|s| !s.is_empty()).collect()
        }
        None => cwd.split('/').filter(|s| !s.is_empty()).collect(),
    };

    if segments.is_empty() {
        return cwd.to_string();
    }

    let keep_full = 2.min(segments.len());
    let abbrev_count = segments.len() - keep_full;

    let mut parts: Vec<String> = Vec::new();
    for (i, seg) in segments.iter().enumerate() {
        if i < abbrev_count {
            parts.push(seg.chars().next().map(|c| c.to_string()).unwrap_or_default());
        } else {
            parts.push(seg.to_string());
        }
    }

    let joined = parts.join("/");
    if path.is_some() {
        format!("~/{joined}")
    } else {
        format!("/{joined}")
    }
}

/// Format question body for the notification.
/// Shows truncated context and a compact option summary.
fn format_question_body(question: &ClaudeQuestion) -> String {
    let context = &question.context_lines;

    // Get the last meaningful line (the actual question text)
    let question_text = context
        .lines()
        .rev()
        .find(|l| {
            let trimmed = l.trim();
            !trimmed.is_empty()
                && !trimmed.starts_with(|c: char| c.is_ascii_digit())
                && !trimmed.starts_with('>')
        })
        .unwrap_or("")
        .trim();

    // Truncate question text
    let question_text = if question_text.len() > 80 {
        let mut end = 80;
        while end > 0 && !question_text.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", question_text[..end].trim_end())
    } else {
        question_text.to_string()
    };

    // Format options compactly
    let options_str: String = question
        .options
        .iter()
        .map(|o| format!("{}.{}", o.number, o.label))
        .collect::<Vec<_>>()
        .join(" ");

    if question_text.is_empty() {
        options_str
    } else if options_str.len() <= 60 {
        format!("{}\n{}", question_text, options_str)
    } else {
        // One option per line
        let options_lines: String = question
            .options
            .iter()
            .map(|o| format!("{}. {}", o.number, o.label))
            .collect::<Vec<_>>()
            .join("\n");
        format!("{}\n{}", question_text, options_lines)
    }
}

/// Send a local notification for a Claude question.
pub fn notify_question(app: &tauri::AppHandle, question: &ClaudeQuestion) {
    let title = compact_cwd(&question.cwd);
    let body = format_question_body(question);

    match app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .sound("default")
        .show()
    {
        Ok(()) => {
            log::info!(
                "[notifications] question notification sent for {}",
                question.question_id
            );
        }
        Err(e) => {
            log::error!("[notifications] failed to send question notification: {}", e);
        }
    }
}

/// Send a local notification for a job event.
pub fn notify_job(app: &tauri::AppHandle, job_name: &str, event: &str) {
    let body = format!("Job {} {}", job_name, event);

    match app
        .notification()
        .builder()
        .title("ClawTab")
        .body(&body)
        .sound("default")
        .show()
    {
        Ok(()) => {
            log::info!(
                "[notifications] job notification sent: {} {}",
                job_name,
                event
            );
        }
        Err(e) => {
            log::error!("[notifications] failed to send job notification: {}", e);
        }
    }
}

/// Fire local notifications for new questions, with deduplication and auto-yes filtering.
pub fn notify_new_questions(
    app: &tauri::AppHandle,
    questions: &[ClaudeQuestion],
    state: &Arc<Mutex<NotificationState>>,
    auto_yes_panes: &Arc<Mutex<HashSet<String>>>,
) {
    let mut notified = state.lock().unwrap();
    let yes_panes = auto_yes_panes.lock().unwrap();

    for q in questions {
        if yes_panes.contains(&q.pane_id) {
            continue;
        }
        if notified.notified_question_ids.contains(&q.question_id) {
            continue;
        }
        notify_question(app, q);
        notified.notified_question_ids.insert(q.question_id.clone());
    }

    // Clean up IDs for questions that are no longer active
    let current_ids: HashSet<String> = questions.iter().map(|q| q.question_id.clone()).collect();
    notified
        .notified_question_ids
        .retain(|id| current_ids.contains(id));
}
