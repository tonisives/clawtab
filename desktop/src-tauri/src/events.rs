/// Trait for emitting UI events. Abstracts over Tauri event emission so that
/// background modules (scheduler, relay handler, watcher, reattach) can notify
/// a connected frontend without depending on Tauri directly.
pub trait EventSink: Send + Sync {
    fn emit_jobs_changed(&self);
    fn emit_auto_yes_changed(&self);
    fn emit_missed_cron_jobs(&self, jobs: Vec<String>);
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
}

/// No-op event sink for daemon mode (no frontend connected).
pub struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn emit_jobs_changed(&self) {}
    fn emit_auto_yes_changed(&self) {}
    fn emit_missed_cron_jobs(&self, _jobs: Vec<String>) {}
}
