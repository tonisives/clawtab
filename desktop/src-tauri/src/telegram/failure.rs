use std::future::Future;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::config::settings::AppSettings;
use crate::history::HistoryStore;

use super::TelegramConfig;

pub(crate) struct JobFailure<'a> {
    pub run_id: &'a str,
    pub group: &'a str,
    pub job_id: &'a str,
    pub slug: &'a str,
    pub chat_id: Option<i64>,
    pub exit_code: Option<i32>,
}

/// Failure alerts are independent of routine completion/log notification settings.
pub(crate) fn enqueue(
    history: &HistoryStore,
    config: Option<&TelegramConfig>,
    failure: JobFailure<'_>,
) {
    let Some(config) = config.filter(|c| c.notify_on_failure && !c.bot_token.is_empty()) else {
        return;
    };
    let text = format!(
        "{}\nRun: <code>{}</code>\nRestart: <code>cwtctl jobs restart {}</code>",
        super::format_job_status_message(
            failure.group,
            failure.job_id,
            "failed",
            failure.exit_code
        ),
        super::html_escape(failure.run_id),
        super::html_escape(failure.slug),
    );
    let chat_ids = failure
        .chat_id
        .map_or_else(|| config.chat_ids.clone(), |id| vec![id]);
    for chat_id in chat_ids {
        if let Err(error) = history.queue_failure_notification(failure.run_id, chat_id, &text) {
            log::error!(
                "Could not queue failure alert for run {}: {}",
                failure.run_id,
                error
            );
        }
    }
}

/// The daemon retries persisted alerts with current credentials after connectivity returns.
pub async fn run(settings: Arc<Mutex<AppSettings>>, history: Arc<Mutex<HistoryStore>>) {
    loop {
        let config = settings.lock().telegram.clone();
        if let Some(config) = config.filter(|c| c.notify_on_failure && !c.bot_token.is_empty()) {
            let bot_token = &config.bot_token;
            if let Err(error) = deliver_pending(&history, |chat_id, message| async move {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    super::send_message(bot_token, chat_id, &message),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err("Telegram failure alert timed out".to_string()),
                }
            })
            .await
            {
                log::warn!("Failure alert delivery deferred: {}", error);
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
}

async fn deliver_pending<F, Fut>(history: &Arc<Mutex<HistoryStore>>, send: F) -> Result<(), String>
where
    F: Fn(i64, String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let pending = history.lock().pending_failure_notifications()?;
    for notification in pending {
        let result = send(notification.chat_id, notification.message).await;
        history
            .lock()
            .record_failure_notification_delivery(notification.id, result.is_ok())?;
        // Avoid repeating timed-out network requests for every queued chat while offline.
        result?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history() -> (tempfile::TempDir, Arc<Mutex<HistoryStore>>) {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = crate::history::test_failure_store(&directory.path().join("history.db"));
        (directory, Arc::new(Mutex::new(store)))
    }

    fn queue(history: &HistoryStore, config: &TelegramConfig, chat_id: Option<i64>) {
        enqueue(
            history,
            Some(config),
            JobFailure {
                run_id: "run-1",
                group: "<local>",
                job_id: "failed & job",
                slug: "local/job",
                chat_id,
                exit_code: Some(7),
            },
        );
    }

    #[test]
    fn failure_alert_uses_failure_setting_and_routes_without_success_notifications() {
        let (_directory, history) = history();
        let mut config = TelegramConfig {
            bot_token: "test-token".to_string(),
            chat_ids: vec![123, 456],
            notify_on_success: false,
            ..Default::default()
        };
        config.notify_on_failure = false;
        queue(&history.lock(), &config, None);
        assert!(history
            .lock()
            .pending_failure_notifications()
            .expect("pending")
            .is_empty());
        config.notify_on_failure = true;
        queue(&history.lock(), &config, Some(789));
        let pending = history
            .lock()
            .pending_failure_notifications()
            .expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].chat_id, 789);
        assert!(pending[0].message.contains("&lt;local&gt;"));
        assert!(pending[0].message.contains("failed &amp; job"));
        assert!(pending[0].message.contains("exit 7"));
        assert!(pending[0].message.contains("cwtctl jobs restart local/job"));
        assert!(!pending[0].message.contains("test-token"));
        queue(&history.lock(), &config, None);
        assert_eq!(
            history
                .lock()
                .pending_failure_notifications()
                .expect("pending")
                .len(),
            3
        );
    }

    #[tokio::test]
    async fn offline_alert_is_retried_after_reopening_the_database() {
        let (directory, history) = history();
        let config = TelegramConfig {
            bot_token: "test-token".to_string(),
            chat_ids: vec![123],
            ..Default::default()
        };
        queue(&history.lock(), &config, None);
        assert!(
            deliver_pending(&history, |_, _| async { Err("offline".to_string()) })
                .await
                .is_err()
        );
        drop(history);
        let store = crate::history::test_failure_store(&directory.path().join("history.db"));
        store.make_failure_retry_due();
        let history = Arc::new(Mutex::new(store));
        let sent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        deliver_pending(&history, |chat, message| {
            assert_eq!(chat, 123);
            assert!(message.contains("exit 7"));
            sent.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            async { Ok(()) }
        })
        .await
        .expect("delivery after reconnect");
        assert_eq!(sent.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert!(history
            .lock()
            .pending_failure_notifications()
            .expect("pending")
            .is_empty());
    }
}
