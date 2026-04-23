use crate::ipc::{self, EventSubscribers, IpcEvent};

/// Trait for emitting UI events. Abstracts over Tauri event emission so that
/// background modules (scheduler, relay handler, watcher, reattach) can notify
/// a connected frontend without depending on Tauri directly.
pub trait EventSink: Send + Sync {
    fn emit_jobs_changed(&self);
    fn emit_auto_yes_changed(&self);
    fn emit_missed_cron_jobs(&self, jobs: Vec<String>);
    fn emit_job_status_changed(&self, name: String, status: crate::config::jobs::JobStatus) {
        let _ = (name, status);
    }
    fn emit_questions_changed(&self) {}
    fn emit_relay_status_changed(&self, status: ipc::IpcRelayStatus) {
        let _ = status;
    }
}

/// Tauri-backed event sink that emits to the webview frontend.
#[cfg(feature = "desktop")]
pub struct TauriEventSink {
    app_handle: tauri::AppHandle,
}

#[cfg(feature = "desktop")]
impl TauriEventSink {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }
}

#[cfg(feature = "desktop")]
impl EventSink for TauriEventSink {
    fn emit_jobs_changed(&self) {
        use tauri::Emitter;
        let _ = self.app_handle.emit("jobs-changed", ());
    }

    fn emit_auto_yes_changed(&self) {
        use tauri::Emitter;
        let _ = self.app_handle.emit("auto-yes-changed", ());
    }

    fn emit_missed_cron_jobs(&self, jobs: Vec<String>) {
        use tauri::Emitter;
        let _ = self.app_handle.emit("missed-cron-jobs", jobs);
    }

    fn emit_job_status_changed(&self, name: String, status: crate::config::jobs::JobStatus) {
        use tauri::Emitter;
        let _ = self
            .app_handle
            .emit("job-status-changed", (name, status));
    }

    fn emit_questions_changed(&self) {
        use tauri::Emitter;
        let _ = self.app_handle.emit("questions-changed", ());
    }

    fn emit_relay_status_changed(&self, status: ipc::IpcRelayStatus) {
        use tauri::Emitter;
        let _ = self.app_handle.emit("relay-status-changed", status);
    }
}

/// Broadcasts events to all IPC event subscribers. Used by the daemon.
pub struct IpcBroadcastEventSink {
    subscribers: EventSubscribers,
}

impl IpcBroadcastEventSink {
    pub fn new(subscribers: EventSubscribers) -> Self {
        Self { subscribers }
    }

    fn spawn_broadcast(&self, event: IpcEvent) {
        let subs = self.subscribers.clone();
        tokio::spawn(async move {
            ipc::broadcast_event(&subs, &event).await;
        });
    }
}

impl EventSink for IpcBroadcastEventSink {
    fn emit_jobs_changed(&self) {
        self.spawn_broadcast(IpcEvent::JobsChanged);
    }

    fn emit_auto_yes_changed(&self) {
        self.spawn_broadcast(IpcEvent::AutoYesChanged);
    }

    fn emit_missed_cron_jobs(&self, jobs: Vec<String>) {
        self.spawn_broadcast(IpcEvent::MissedCronJobs(jobs));
    }

    fn emit_job_status_changed(&self, name: String, status: crate::config::jobs::JobStatus) {
        self.spawn_broadcast(IpcEvent::JobStatusChanged { name, status });
    }

    fn emit_questions_changed(&self) {
        self.spawn_broadcast(IpcEvent::QuestionsChanged);
    }

    fn emit_relay_status_changed(&self, status: ipc::IpcRelayStatus) {
        self.spawn_broadcast(IpcEvent::RelayStatusChanged(status));
    }
}

/// Desktop-side loop that connects to the daemon's event server and forwards
/// each IpcEvent to the Tauri frontend via `app_handle.emit`. Reconnects on
/// disconnect.
#[cfg(feature = "desktop")]
pub async fn run_daemon_event_subscription(app_handle: tauri::AppHandle) {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;

    loop {
        let reader = match ipc::subscribe_events().await {
            Ok(r) => r,
            Err(e) => {
                log::debug!("Event subscription not yet available: {}", e);
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };

        log::info!("Subscribed to daemon event stream");
        let mut lines = reader.lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<IpcEvent>(&line) {
                    Ok(event) => match event {
                        IpcEvent::JobsChanged => {
                            let _ = app_handle.emit("jobs-changed", ());
                        }
                        IpcEvent::AutoYesChanged => {
                            let _ = app_handle.emit("auto-yes-changed", ());
                        }
                        IpcEvent::MissedCronJobs(jobs) => {
                            let _ = app_handle.emit("missed-cron-jobs", jobs);
                        }
                        IpcEvent::JobStatusChanged { name, status } => {
                            let _ = app_handle.emit("job-status-changed", (name, status));
                        }
                        IpcEvent::QuestionsChanged => {
                            let _ = app_handle.emit("questions-changed", ());
                        }
                        IpcEvent::RelayStatusChanged(status) => {
                            let _ = app_handle.emit("relay-status-changed", status);
                        }
                    },
                    Err(e) => {
                        log::warn!("Failed to parse IPC event: {} ({:?})", e, line);
                    }
                },
                Ok(None) => {
                    log::info!("Daemon event stream closed, reconnecting");
                    break;
                }
                Err(e) => {
                    log::warn!("Event stream read error: {}, reconnecting", e);
                    break;
                }
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// No-op event sink for tests or legacy callers. Prefer a real sink.
pub struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn emit_jobs_changed(&self) {}
    fn emit_auto_yes_changed(&self) {}
    fn emit_missed_cron_jobs(&self, _jobs: Vec<String>) {}
}
