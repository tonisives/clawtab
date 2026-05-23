use std::collections::HashSet;
use std::sync::Arc;
use parking_lot::Mutex;

use clawtab_protocol::ClaudeQuestion;

use crate::ipc::{self, EventSubscribers, IpcEvent};

/// Trait for sending notifications. Abstracts over Tauri plugin notifications
/// so that daemon mode can fall back to osascript.
pub trait Notifier: Send + Sync {
    fn notify_question(&self, question: &ClaudeQuestion);
    fn notify_job(&self, job_id: &str, event: &str);
}

/// Tauri-backed notifier using tauri-plugin-notification.
#[cfg(feature = "desktop")]
pub struct TauriNotifier {
    app_handle: tauri::AppHandle,
}

#[cfg(feature = "desktop")]
impl TauriNotifier {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }
}

#[cfg(feature = "desktop")]
impl Notifier for TauriNotifier {
    fn notify_question(&self, question: &ClaudeQuestion) {
        use tauri_plugin_notification::NotificationExt;
        let title = compact_cwd(&question.cwd);
        let body = format_question_body(question);
        match self
            .app_handle
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
                log::error!(
                    "[notifications] failed to send question notification: {}",
                    e
                );
            }
        }
    }

    fn notify_job(&self, job_id: &str, event: &str) {
        use tauri_plugin_notification::NotificationExt;
        let body = format!("Job {} {}", job_id, event);
        match self
            .app_handle
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
                    job_id,
                    event
                );
            }
            Err(e) => {
                log::error!("[notifications] failed to send job notification: {}", e);
            }
        }
    }
}

/// Fallback notifier for daemon mode.
/// Uses terminal-notifier (with ClawTab icon) if available, falls back to osascript.
pub struct OsascriptNotifier;

impl OsascriptNotifier {
    fn send_notification(title: &str, body: &str) -> Result<(), String> {
        // Preferred path: UNUserNotificationCenter via objc2-user-notifications.
        // Works whenever the daemon is launched from inside Clawtab Engine.app
        // (the launchd plist points at the .app's binary). No subprocess, no
        // leak, native ClawTab icon from the bundle's Info.plist.
        #[cfg(target_os = "macos")]
        {
            if crate::native_notifications::send(title, body).is_ok() {
                return Ok(());
            }
        }

        // Fallback for non-bundled invocations (running the bare binary by
        // hand, for example). osascript's "display notification" is a one-shot
        // that exits as soon as the banner is queued, so no zombie process.
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            body.replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', " "),
            title.replace('\\', "\\\\").replace('"', "\\\""),
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

impl Notifier for OsascriptNotifier {
    fn notify_question(&self, question: &ClaudeQuestion) {
        let title = compact_cwd(&question.cwd);
        let body = format_question_body(question);
        match Self::send_notification(&title, &body) {
            Ok(()) => log::info!(
                "[notifications] question notification sent for {}",
                question.question_id
            ),
            Err(e) => log::error!("[notifications] question notification failed: {}", e),
        }
    }

    fn notify_job(&self, job_id: &str, event: &str) {
        let body = format!("Job {} {}", job_id, event);
        match Self::send_notification("ClawTab", &body) {
            Ok(()) => log::info!(
                "[notifications] job notification sent: {} {}",
                job_id,
                event
            ),
            Err(e) => log::error!("[notifications] job notification failed: {}", e),
        }
    }
}

/// Preferred daemon-side notifier. Routes notifications to the desktop app
/// (which displays them natively via tauri-plugin-notification) when at least
/// one IPC subscriber is connected. Falls back to terminal-notifier when the
/// desktop app isn't running, so notifications still surface in headless use.
///
/// The IPC path is leak-free because the desktop app owns the notification.
/// The fallback path also no longer leaks: OsascriptNotifier reaps its child.
pub struct IpcNotifier {
    subscribers: EventSubscribers,
}

impl IpcNotifier {
    pub fn new(subscribers: EventSubscribers) -> Self {
        Self { subscribers }
    }

    fn dispatch(&self, title: String, body: String) {
        let subs = self.subscribers.clone();
        let title_for_fallback = title.clone();
        let body_for_fallback = body.clone();
        tokio::spawn(async move {
            let event = IpcEvent::Notification {
                title: title.clone(),
                body: body.clone(),
            };
            let delivered = ipc::broadcast_event(&subs, &event).await;
            if delivered == 0 {
                // Desktop not subscribed; emit locally so the user still sees it.
                let _ = OsascriptNotifier::send_notification(
                    &title_for_fallback,
                    &body_for_fallback,
                );
            }
        });
    }
}

impl Notifier for IpcNotifier {
    fn notify_question(&self, question: &ClaudeQuestion) {
        let title = compact_cwd(&question.cwd);
        let body = format_question_body(question);
        log::info!(
            "[notifications] dispatching question {} via IPC",
            question.question_id
        );
        self.dispatch(title, body);
    }

    fn notify_job(&self, job_id: &str, event: &str) {
        let body = format!("Job {} {}", job_id, event);
        log::info!(
            "[notifications] dispatching job notification: {} {} via IPC",
            job_id,
            event
        );
        self.dispatch("ClawTab".to_string(), body);
    }
}

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
            parts.push(
                seg.chars()
                    .next()
                    .map(|c| c.to_string())
                    .unwrap_or_default(),
            );
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

/// Fire local notifications for new questions, with deduplication and auto-yes filtering.
pub fn notify_new_questions(
    notifier: &dyn Notifier,
    questions: &[ClaudeQuestion],
    state: &Arc<Mutex<NotificationState>>,
    auto_yes_panes: &Arc<Mutex<HashSet<String>>>,
) {
    let mut notified = state.lock();
    let yes_panes = auto_yes_panes.lock();

    for q in questions {
        if yes_panes.contains(&q.pane_id) {
            continue;
        }
        if notified.notified_question_ids.contains(&q.question_id) {
            continue;
        }
        notifier.notify_question(q);
        notified.notified_question_ids.insert(q.question_id.clone());
    }

    // Clean up IDs for questions that are no longer active
    let current_ids: HashSet<String> = questions.iter().map(|q| q.question_id.clone()).collect();
    notified
        .notified_question_ids
        .retain(|id| current_ids.contains(id));
}
