use rusqlite::params;

use super::HistoryStore;

pub(crate) struct PendingFailureNotification {
    pub id: i64,
    pub chat_id: i64,
    pub message: String,
}

impl HistoryStore {
    #[cfg(test)]
    pub(crate) fn make_failure_retry_due(&self) {
        self.conn
            .execute("UPDATE failure_notifications SET retry_at = 0", [])
            .expect("retry due");
    }

    pub(crate) fn initialize_failure_notifications(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS failure_notifications (
                id INTEGER PRIMARY KEY,
                run_id TEXT NOT NULL,
                chat_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                retry_at INTEGER NOT NULL DEFAULT 0,
                delivered_at INTEGER,
                UNIQUE(run_id, chat_id)
            );
            DELETE FROM failure_notifications
                WHERE delivered_at < unixepoch('now', '-30 days');",
            )
            .map_err(|e| format!("Failed to initialize failure notifications: {e}"))
    }

    pub(crate) fn queue_failure_notification(
        &self,
        run_id: &str,
        chat_id: i64,
        message: &str,
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT OR IGNORE INTO failure_notifications (run_id, chat_id, message) VALUES (?1, ?2, ?3)",
            params![run_id, chat_id, message],
        ).map(|_| ()).map_err(|e| format!("Failed to queue failure notification: {e}"))
    }

    pub(crate) fn pending_failure_notifications(
        &self,
    ) -> Result<Vec<PendingFailureNotification>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT id, chat_id, message FROM failure_notifications
             WHERE delivered_at IS NULL AND retry_at <= unixepoch()
             ORDER BY retry_at, id LIMIT 20",
            )
            .map_err(|e| format!("Failed to query failure notifications: {e}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(PendingFailureNotification {
                    id: row.get(0)?,
                    chat_id: row.get(1)?,
                    message: row.get(2)?,
                })
            })
            .map_err(|e| format!("Failed to read failure notifications: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect failure notifications: {e}"))
    }

    pub(crate) fn record_failure_notification_delivery(
        &self,
        id: i64,
        delivered: bool,
    ) -> Result<(), String> {
        let sql = if delivered {
            "UPDATE failure_notifications SET delivered_at = unixepoch() WHERE id = ?1"
        } else {
            "UPDATE failure_notifications SET retry_at = unixepoch() + 30 WHERE id = ?1"
        };
        self.conn
            .execute(sql, [id])
            .map(|_| ())
            .map_err(|e| format!("Failed to update failure notification: {e}"))
    }
}

#[cfg(test)]
pub(crate) fn test_store(path: &std::path::Path) -> HistoryStore {
    let store = HistoryStore {
        conn: rusqlite::Connection::open(path).expect("test database"),
    };
    store
        .initialize_failure_notifications()
        .expect("notification table");
    store
}

#[cfg(test)]
mod tests {
    use super::test_store;

    #[test]
    fn queued_failure_survives_reopen_and_deduplicates_delivery() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("history.db");
        let store = test_store(&path);
        store
            .queue_failure_notification("run-1", 123, "Job failed")
            .expect("queue");
        store
            .queue_failure_notification("run-1", 123, "Job failed")
            .expect("duplicate");
        drop(store);
        let store = test_store(&path);
        let pending = store.pending_failure_notifications().expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].chat_id, 123);
        assert_eq!(pending[0].message, "Job failed");
        store
            .record_failure_notification_delivery(pending[0].id, true)
            .expect("delivered");
        store
            .queue_failure_notification("run-1", 123, "Job failed")
            .expect("duplicate after delivery");
        assert!(store
            .pending_failure_notifications()
            .expect("pending")
            .is_empty());
        store
            .queue_failure_notification("run-1", 456, "Job failed")
            .expect("second chat");
        assert_eq!(
            store
                .pending_failure_notifications()
                .expect("pending")
                .len(),
            1
        );
    }

    #[test]
    fn unsuccessful_delivery_stays_queued_with_backoff() {
        let directory = tempfile::tempdir().expect("temp directory");
        let store = test_store(&directory.path().join("history.db"));
        store
            .queue_failure_notification("run-1", 123, "Job failed")
            .expect("queue");
        let pending = store.pending_failure_notifications().expect("pending");
        store
            .record_failure_notification_delivery(pending[0].id, false)
            .expect("retry");
        assert!(store
            .pending_failure_notifications()
            .expect("pending")
            .is_empty());
        store
            .conn
            .execute("UPDATE failure_notifications SET retry_at = 0", [])
            .expect("retry due");
        assert_eq!(
            store
                .pending_failure_notifications()
                .expect("pending")
                .len(),
            1
        );
    }
}
