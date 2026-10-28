use crate::agent_session::{self, ProcessProvider, ProcessSnapshot};
use crate::history::HistoryStore;
use crate::nfn::NfnSource;
use parking_lot::Mutex;
use std::sync::Arc;

pub(super) struct Capture {
    source: Mutex<NfnSource>,
    history: Arc<Mutex<HistoryStore>>,
}

impl Capture {
    pub(super) fn new(source: NfnSource, history: Arc<Mutex<HistoryStore>>) -> Self {
        Self {
            source: Mutex::new(source),
            history,
        }
    }

    fn recorded(&self) -> bool {
        self.source.lock().session_id.is_some()
    }

    pub(super) fn observe_process(&self, pid: u32) {
        if self.recorded() {
            return;
        }
        let pid = pid.to_string();
        let snapshot = ProcessSnapshot::capture();
        let Some(provider) = agent_session::detect_process_provider(&pid, Some(&snapshot)) else {
            return;
        };
        let cwd = self.source.lock().cwd.clone();
        let info = agent_session::resolve_session_info_for_provider_with_cwd_fast(
            &pid,
            Some(provider),
            Some(&snapshot),
            cwd.as_deref(),
        );
        let Some(session) = info.session_id else {
            return;
        };
        let home = (provider == ProcessProvider::Hermes)
            .then(|| agent_session::hermes::identity_for_pane(&pid, Some(&snapshot)))
            .flatten()
            .map(|identity| identity.home.to_string_lossy().into_owned());
        self.record(provider, session, home);
    }

    fn observe_line(&self, line: &[u8]) {
        if let Some((provider, session)) = agent_session::session_announcement(line) {
            self.record(provider, session, None);
        }
    }

    fn record(&self, provider: ProcessProvider, session: String, home: Option<String>) {
        if session.trim().is_empty() || session.len() > 256 || provider == ProcessProvider::Shell {
            return;
        }
        let mut source = self.source.lock();
        if source.session_id.is_some() {
            return;
        }
        let mut captured = source.clone();
        captured.provider = Some(provider.as_str().into());
        captured.provider_home = home;
        captured.session_id = Some(session);
        let Some(run) = captured.run_id.as_deref() else {
            return;
        };
        match self.history.lock().save_notification_source(run, &captured) {
            Ok(()) => *source = captured,
            Err(error) => log::warn!("[{run}] {error}"),
        }
    }
}

// Read session announcements before the bounded output tail drops them. Each
// pipe keeps its own partial line; stdout and stderr share the run's capture.
pub(super) struct Output {
    capture: Arc<Capture>,
    pending: Vec<u8>,
    discard_line: bool,
}

impl Output {
    pub(super) fn new(capture: Arc<Capture>) -> Self {
        Self {
            capture,
            pending: Vec::new(),
            discard_line: false,
        }
    }

    pub(super) fn push(&mut self, chunk: &[u8]) {
        if self.capture.recorded() {
            return;
        }
        for part in chunk.split_inclusive(|byte| *byte == b'\n') {
            if self.pending.len() + part.len() > 64 * 1024 {
                self.pending.clear();
                self.discard_line = true;
            }
            if !self.discard_line {
                self.pending.extend_from_slice(part);
            }
            if part.ends_with(b"\n") {
                self.finish();
                self.discard_line = false;
            }
        }
    }

    pub(super) fn finish(&mut self) {
        if !self.pending.is_empty() {
            self.capture.observe_line(&self.pending);
            self.pending.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(path: &std::path::Path) -> Arc<Capture> {
        rusqlite::Connection::open(path)
            .unwrap()
            .execute_batch("CREATE TABLE runs (id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('run'), ('other');")
            .unwrap();
        let history = crate::history::test_failure_store(path);
        history.initialize_notification_sources().unwrap();
        Arc::new(Capture::new(
            NfnSource {
                job_id: Some("project/script".into()),
                run_id: Some("run".into()),
                cwd: Some("/workspace/project".into()),
                group: Some("project".into()),
                ..Default::default()
            },
            Arc::new(Mutex::new(history)),
        ))
    }

    #[test]
    fn binary_sessions_survive_split_output_large_logs_and_process_exit() {
        for (announcement, provider) in [
            (
                r#"{"type":"thread.started","thread_id":"conversation"}"#,
                "codex",
            ),
            (
                r#"{"type":"system","subtype":"init","session_id":"conversation"}"#,
                "claude",
            ),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("history.db");
            let capture = capture(&path);
            let mut output = Output::new(capture.clone());
            output.push(&vec![b'x'; 70 * 1024]);
            output.push(b"\n");
            output.push(&announcement.as_bytes()[..20]);
            output.push(&announcement.as_bytes()[20..]);
            output.finish();
            output.push(&vec![b'x'; 2 * 1024 * 1024]);
            drop(output);
            drop(capture);

            let history = crate::history::test_failure_store(&path);
            let source = history.notification_source("run").unwrap().unwrap();
            assert_eq!(source.session_id.as_deref(), Some("conversation"));
            assert_eq!(source.provider.as_deref(), Some(provider));
            assert_eq!(source.cwd.as_deref(), Some("/workspace/project"));
            assert_eq!(source.job_id.as_deref(), Some("project/script"));
            assert!(source.pane_id.is_none());
            assert!(history.notification_source("other").unwrap().is_none());
        }
    }

    #[test]
    fn script_output_without_an_agent_announcement_keeps_no_session() {
        let directory = tempfile::tempdir().unwrap();
        let capture = capture(&directory.path().join("history.db"));
        let mut output = Output::new(capture.clone());
        output.push(b"script failed\n{\"session_id\":\"unrelated\"}\n");
        output.push(b"{\"type\":\"thread.started\",\"thread_id\":\" \"}\n");
        output.push(b"{\"type\":\"system\",\"subtype\":\"other\",\"session_id\":\"unrelated\"}\n");
        output.finish();
        assert!(capture
            .history
            .lock()
            .notification_source("run")
            .unwrap()
            .is_none());
    }
}
