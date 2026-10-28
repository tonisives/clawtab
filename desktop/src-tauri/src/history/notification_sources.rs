use super::HistoryStore;
use crate::nfn::NfnSource;

impl HistoryStore {
    pub(crate) fn initialize_notification_sources(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS run_notification_sources (
            run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
            source TEXT NOT NULL
        );
        DELETE FROM run_notification_sources WHERE run_id NOT IN (SELECT id FROM runs);",
            )
            .map_err(|error| format!("Failed to initialize run sources: {error}"))
    }

    pub(crate) fn save_notification_source(
        &self,
        run_id: &str,
        source: &NfnSource,
    ) -> Result<(), String> {
        let source = serde_json::to_string(source).map_err(|error| error.to_string())?;
        self.conn
            .execute(
                "INSERT INTO run_notification_sources (run_id, source) VALUES (?1, ?2)
            ON CONFLICT(run_id) DO UPDATE SET source = excluded.source",
                rusqlite::params![run_id, source],
            )
            .map(|_| ())
            .map_err(|error| format!("Failed to save run source: {error}"))
    }

    pub(crate) fn notification_source(&self, run_id: &str) -> Result<Option<NfnSource>, String> {
        use rusqlite::OptionalExtension;
        let source: Option<String> = self
            .conn
            .query_row(
                "SELECT source FROM run_notification_sources WHERE run_id = ?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        source
            .map(|source| serde_json::from_str(&source).map_err(|error| error.to_string()))
            .transpose()
    }

    pub(crate) fn recover_notification_source(
        &self,
        run_id: &str,
        fallback: NfnSource,
    ) -> Result<Option<NfnSource>, String> {
        use rusqlite::OptionalExtension;
        use std::io::Read;

        let mut source = self
            .notification_source(run_id)?
            .unwrap_or_else(|| fallback.clone());
        if source.session_id.is_some() {
            return Ok(Some(source));
        }
        let output = self.conn.query_row(
            "SELECT job_name, substr(stdout, 1, 1048576), substr(stderr, 1, 1048576), log_path FROM runs WHERE id = ?1",
            [run_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)),
        ).optional().map_err(|error| error.to_string())?;
        let Some((job, stdout, stderr, log_path)) = output else {
            return Ok(None);
        };
        if fallback
            .job_id
            .as_ref()
            .is_some_and(|expected| expected != &job)
        {
            return Ok(None);
        }
        let from_log = log_path.and_then(|path| {
            let mut prefix = Vec::new();
            std::fs::File::open(path)
                .ok()?
                .take(1024 * 1024)
                .read_to_end(&mut prefix)
                .ok()?;
            crate::agent_session::session_from_output(&String::from_utf8_lossy(&prefix))
        });
        let session = from_log
            .or_else(|| crate::agent_session::session_from_output(&stdout))
            .or_else(|| crate::agent_session::session_from_output(&stderr));
        let Some((provider, session)) = session else {
            return Ok(None);
        };
        source.job_id = Some(job);
        source.run_id = Some(run_id.into());
        source.cwd = source.cwd.or(fallback.cwd);
        source.group = source.group.or(fallback.group);
        source.provider = Some(provider.as_str().into());
        source.session_id = Some(session);
        self.save_notification_source(run_id, &source)?;
        Ok(Some(source))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_source_survives_exit_and_database_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let store = HistoryStore {
            conn: rusqlite::Connection::open(&path).unwrap(),
        };
        store.conn.execute_batch("CREATE TABLE runs (id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('failed'), ('newer');").unwrap();
        store.initialize_notification_sources().unwrap();
        let source = NfnSource {
            pane_id: Some("%17".into()),
            session_id: Some("conversation".into()),
            provider: Some("codex".into()),
            cwd: Some("/workspace".into()),
            ..Default::default()
        };
        store.save_notification_source("failed", &source).unwrap();
        drop(store);
        let store = HistoryStore {
            conn: rusqlite::Connection::open(path).unwrap(),
        };
        assert_eq!(store.notification_source("failed").unwrap(), Some(source));
        assert_eq!(store.notification_source("newer").unwrap(), None);
    }

    #[test]
    fn recovers_the_failed_runs_session_from_its_own_log_prefix() {
        let directory = tempfile::tempdir().unwrap();
        let log = directory.path().join("failed.log");
        let announcement = "{\"type\":\"thread.started\",\"thread_id\":\"failed-session\"}\n";
        std::fs::write(
            &log,
            format!(
                "starting repair\n{announcement}{}",
                "x".repeat(2 * 1024 * 1024)
            ),
        )
        .unwrap();
        let store = HistoryStore {
            conn: rusqlite::Connection::open_in_memory().unwrap(),
        };
        store.conn.execute_batch("CREATE TABLE runs (id TEXT PRIMARY KEY, job_name TEXT, stdout TEXT DEFAULT '', stderr TEXT DEFAULT '', log_path TEXT);").unwrap();
        store.conn.execute("INSERT INTO runs (id, job_name, stdout, log_path) VALUES ('failed', 'project/repair', 'truncated output', ?1), ('newer', 'project/repair', '', NULL)", [log.to_string_lossy().as_ref()]).unwrap();
        store.initialize_notification_sources().unwrap();
        let fallback = NfnSource {
            job_id: Some("project/repair".into()),
            cwd: Some("/workspace/project".into()),
            group: Some("project".into()),
            ..Default::default()
        };
        let source = store
            .recover_notification_source("failed", fallback.clone())
            .unwrap()
            .unwrap();
        assert_eq!(source.session_id.as_deref(), Some("failed-session"));
        assert_eq!(source.provider.as_deref(), Some("codex"));
        assert_eq!(source.run_id.as_deref(), Some("failed"));
        assert_eq!(source.cwd.as_deref(), Some("/workspace/project"));
        assert!(source.pane_id.is_none());
        assert!(store
            .recover_notification_source("newer", fallback)
            .unwrap()
            .is_none());
        std::fs::remove_file(log).unwrap();
        assert_eq!(store.notification_source("failed").unwrap(), Some(source));
    }

    #[test]
    fn inline_announcements_recover_without_a_log_but_unrelated_json_does_not() {
        let store = HistoryStore {
            conn: rusqlite::Connection::open_in_memory().unwrap(),
        };
        store.conn.execute_batch("CREATE TABLE runs (id TEXT PRIMARY KEY, job_name TEXT, stdout TEXT DEFAULT '', stderr TEXT DEFAULT '', log_path TEXT);").unwrap();
        store.conn.execute("INSERT INTO runs (id, job_name, stderr) VALUES ('failed', 'project/script', ?1), ('plain', 'project/script', '{\"session_id\":\"unrelated\"}')", [r#"{"type":"system","subtype":"init","session_id":"claude-session"}"#]).unwrap();
        store.initialize_notification_sources().unwrap();
        let fallback = NfnSource {
            job_id: Some("project/script".into()),
            ..Default::default()
        };
        let wrong_job = NfnSource {
            job_id: Some("other/script".into()),
            ..Default::default()
        };
        assert!(store
            .recover_notification_source("failed", wrong_job)
            .unwrap()
            .is_none());
        let source = store
            .recover_notification_source("failed", fallback.clone())
            .unwrap()
            .unwrap();
        assert_eq!(source.provider.as_deref(), Some("claude"));
        assert_eq!(source.session_id.as_deref(), Some("claude-session"));
        assert!(store
            .recover_notification_source("plain", fallback)
            .unwrap()
            .is_none());
    }
}
