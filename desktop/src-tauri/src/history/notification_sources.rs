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
}
