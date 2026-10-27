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
        notify: JobNotify {
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
async fn default_notifications_skip_start_and_keep_completion() {
    let directory = tempfile::tempdir().expect("test directory");
    let mut params = params(directory.path(), NotifyTarget::App, true);
    let notifier = Arc::new(RecordingNotifier::default());
    params.notifier = Some(notifier.clone());
    notify_start(&params, false, true).await;
    assert!(notifier.0.lock().is_empty());
    notify_finish(&params, false, true, Some(0), true).await;
    assert_eq!(
        notifier.0.lock().as_slice(),
        &[("local/quiet-job".to_string(), "completed".to_string())]
    );
}

#[tokio::test]
async fn start_alert_requires_opt_in_and_is_never_repeated_on_reattach() {
    let directory = tempfile::tempdir().expect("test directory");
    let mut params = params(directory.path(), NotifyTarget::App, true);
    let notifier = Arc::new(RecordingNotifier::default());
    params.notifier = Some(notifier.clone());
    params.notify.start = true;
    notify_start(&params, false, true).await;
    params.is_reattach = true;
    notify_start(&params, false, true).await;
    assert_eq!(
        notifier.0.lock().as_slice(),
        &[("local/quiet-job".to_string(), "started".to_string())]
    );
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

#[tokio::test]
async fn manual_shell_close_records_success_and_only_notifies_completion() {
    let directory = tempfile::tempdir().expect("test directory");
    let mut params = params(directory.path(), NotifyTarget::App, true);
    let recorder = Arc::new(RecordingNotifier::default());
    params.notifier = Some(recorder.clone());
    rusqlite::Connection::open(directory.path().join("history.db"))
        .expect("history connection")
        .execute_batch(
            "CREATE TABLE runs (
                id TEXT PRIMARY KEY, job_name TEXT NOT NULL, started_at TEXT NOT NULL,
                finished_at TEXT, exit_code INTEGER, trigger_type TEXT NOT NULL,
                stdout TEXT NOT NULL DEFAULT '', stderr TEXT NOT NULL DEFAULT '',
                pane_id TEXT, log_path TEXT
            );",
        )
        .expect("runs table");
    params
        .history
        .lock()
        .insert(&crate::history::RunRecord {
            id: params.run_id.clone(),
            job_id: params.slug.clone(),
            started_at: Utc::now().to_rfc3339(),
            finished_at: None,
            exit_code: None,
            trigger: "manual".into(),
            stdout: String::new(),
            stderr: String::new(),
            pane_id: Some("%17".into()),
            log_path: None,
        })
        .expect("running job");

    let exit_code = pane_completion(Ok(tmux::PaneProcessState::Missing))
        .expect("closed pane completes");
    let succeeded = exit_code == Some(0);
    persist_finish(&params, "work completed", exit_code, succeeded);
    notify_finish(&params, false, true, exit_code, succeeded).await;

    let history = params.history.lock();
    let run = history
        .get_by_id(&params.run_id)
        .expect("saved run")
        .expect("run exists");
    assert!(run.finished_at.is_some());
    assert_eq!(run.exit_code, Some(0));
    assert_eq!(run.stdout, "work completed");
    assert!(matches!(
        params.job_status.lock().get(&params.slug),
        Some(JobStatus::Success { .. })
    ));
    assert!(history
        .pending_failure_notifications()
        .expect("pending")
        .is_empty());
    assert_eq!(
        recorder.0.lock().as_slice(),
        &[(params.slug.clone(), "completed".into())]
    );
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
