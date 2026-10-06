use super::*;
use crate::telegram::TelegramConfig;

fn params(directory: &std::path::Path, target: NotifyTarget, finish: bool) -> MonitorParams {
    let mut settings = crate::config::settings::AppSettings::default();
    settings.telegram = Some(TelegramConfig {
        bot_token: "test-token".to_string(),
        chat_ids: vec![123],
        notify_on_success: false,
        ..Default::default()
    });
    MonitorParams {
        tmux_session: String::new(),
        pane_id: String::new(),
        run_id: "run-1".to_string(),
        job_id: "quiet-job".to_string(),
        group_name: "local".to_string(),
        slug: "local/quiet-job".to_string(),
        agent_group: None,
        agent_prompt_path: None,
        retired_one_shot: false,
        kill_on_end: false,
        telegram: None,
        telegram_notify: TelegramNotify {
            finish,
            ..Default::default()
        },
        notify_target: target,
        history: Arc::new(Mutex::new(crate::history::test_failure_store(
            &directory.join("history.db"),
        ))),
        job_status: Arc::new(Mutex::new(HashMap::new())),
        notify_on_success: false,
        settings: Arc::new(Mutex::new(settings)),
        telegram_chat_id: None,
        relay: Arc::new(Mutex::new(None)),
        notifier: None,
        is_reattach: false,
        protected_panes: Arc::new(Mutex::new(HashSet::new())),
        trigger_id: None,
        result_file: None,
        resource_lease: None,
    }
}

#[tokio::test]
async fn quiet_and_app_jobs_still_queue_one_failure_alert() {
    for target in [
        NotifyTarget::None,
        NotifyTarget::App,
        NotifyTarget::Telegram,
    ] {
        let directory = tempfile::tempdir().expect("test directory");
        let params = params(directory.path(), target, false);
        notify_finish(&params, false, false, Some(1), false).await;
        notify_finish(&params, false, false, Some(1), false).await;
        let alerts = params
            .history
            .lock()
            .pending_failure_notifications()
            .expect("pending");
        assert_eq!(alerts.len(), 1);
        assert!(alerts[0].message.contains("quiet-job"));
        assert!(alerts[0].message.contains("exit 1"));
    }
}

#[tokio::test]
async fn successful_job_never_queues_failure_alert() {
    let directory = tempfile::tempdir().expect("test directory");
    let params = params(directory.path(), NotifyTarget::None, false);
    notify_finish(&params, false, false, Some(0), true).await;
    assert!(params
        .history
        .lock()
        .pending_failure_notifications()
        .expect("pending")
        .is_empty());
}

#[derive(Default)]
struct RecordingNotifier(Mutex<Vec<(String, String)>>);

impl crate::notifications::Notifier for RecordingNotifier {
    fn notify_question(&self, _: &clawtab_protocol::ClaudeQuestion) {}
    fn notify_job(&self, job: &str, event: &str) {
        self.0.lock().push((job.to_string(), event.to_string()));
    }
}

#[tokio::test]
async fn local_failure_banner_is_immediate_without_telegram_and_never_doubled_for_app_jobs() {
    for target in [
        NotifyTarget::None,
        NotifyTarget::App,
        NotifyTarget::Telegram,
    ] {
        for finish in [false, true] {
            let directory = tempfile::tempdir().expect("test directory");
            let use_app = target == NotifyTarget::App;
            let mut params = params(directory.path(), target.clone(), finish);
            params.settings.lock().telegram = None;
            let recorder = Arc::new(RecordingNotifier::default());
            params.notifier = Some(recorder.clone());
            notify_finish(&params, false, use_app, Some(7), false).await;
            assert_eq!(
                *recorder.0.lock(),
                vec![("local/quiet-job".to_string(), "failed (exit 7)".to_string())]
            );
            assert!(params
                .history
                .lock()
                .pending_failure_notifications()
                .expect("pending")
                .is_empty());
        }
    }
}

#[tokio::test]
async fn local_failure_banner_setting_does_not_disable_queued_telegram_alerts() {
    let directory = tempfile::tempdir().expect("test directory");
    let mut params = params(directory.path(), NotifyTarget::App, true);
    params.settings.lock().notify_job_failures_local = false;
    let recorder = Arc::new(RecordingNotifier::default());
    params.notifier = Some(recorder.clone());
    notify_finish(&params, false, true, Some(7), false).await;
    assert!(recorder.0.lock().is_empty());
    assert_eq!(
        params
            .history
            .lock()
            .pending_failure_notifications()
            .expect("pending")
            .len(),
        1
    );
}

#[test]
fn existing_settings_enable_local_failure_banners_by_default() {
    let settings: crate::config::settings::AppSettings =
        serde_yml::from_str("{}").expect("existing config");
    assert!(settings.notify_job_failures_local);
}
