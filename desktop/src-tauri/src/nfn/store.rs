use super::{templates, types::*};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        Self::from_connection(Connection::open(path).map_err(|e| e.to_string())?)
    }

    fn from_connection(conn: Connection) -> Result<Self, String> {
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY, status TEXT NOT NULL, dedupe TEXT, record TEXT NOT NULL,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS nfn_status ON notifications(status, created_at);
            CREATE UNIQUE INDEX IF NOT EXISTS nfn_active_dedupe ON notifications(dedupe)
                WHERE status IN ('pending', 'delivering') AND dedupe IS NOT NULL;",
        )
        .map_err(|e| e.to_string())?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        // An interrupted dispatch is never replayed into an agent after restart.
        for mut record in store.list_where("status = 'delivering'", 0, 10000)? {
            record.status = "cancelled".into();
            record.error = Some(
                "Daemon restarted during delivery; check the agent before submitting again".into(),
            );
            store.save(&mut record)?;
        }
        store.conn.lock().execute("DELETE FROM notifications WHERE status NOT IN ('pending', 'delivering') AND updated_at < ?1", [now() - 30 * 86400000]).map_err(|e| e.to_string())?;
        Ok(store)
    }

    pub fn get(&self, id: &str) -> Result<NfnRecord, String> {
        let raw: Option<String> = self
            .conn
            .lock()
            .query_row(
                "SELECT record FROM notifications WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&raw.ok_or_else(|| format!("Notification not found: {id}"))?)
            .map_err(|e| e.to_string())
    }

    fn list_where(
        &self,
        clause: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<NfnRecord>, String> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare(&format!("SELECT record FROM notifications WHERE {clause} ORDER BY created_at DESC, id LIMIT ?1 OFFSET ?2")).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![limit as i64, offset as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }

    pub fn list(&self, offset: usize) -> Result<Vec<NfnRecord>, String> {
        self.list_where("1=1", offset, 50)
    }
    pub fn pending_count(&self) -> Result<usize, String> {
        self.conn.lock().query_row("SELECT count(*) FROM notifications WHERE status IN ('pending','delivering') AND json_extract(record,'$.dismissed_at') IS NULL", [], |row| row.get(0)).map_err(|e| e.to_string())
    }
    pub fn pending_page(&self, offset: usize) -> Result<Vec<NfnRecord>, String> {
        self.list_where(
            "status IN ('pending','delivering') AND json_extract(record,'$.dismissed_at') IS NULL",
            offset,
            50,
        )
    }
    pub fn pending(&self) -> Result<Vec<NfnRecord>, String> {
        self.list_where("status IN ('pending', 'delivering')", 0, 2000)
    }

    pub fn deliveries_to_close(&self) -> Result<Vec<NfnRecord>, String> {
        self.list_where(
            "(status NOT IN ('pending','delivering') OR json_extract(record,'$.dismissed_at') IS NOT NULL)
             AND EXISTS (SELECT 1 FROM json_each(record,'$.deliveries')
                WHERE key LIKE 'telegram:%' AND json_extract(value,'$.status') IN ('sent','closing','close_failed'))",
            0,
            2000,
        )
    }

    pub fn send(
        &self,
        mut request: NfnRequest,
        question_id: Option<String>,
    ) -> Result<(NfnRecord, bool), String> {
        if request.kind.is_empty() {
            request.kind = request.message_kind().to_string();
        }
        request.validate()?;
        let template = templates::load_one(&request.template)?;
        if request.actions.is_empty() && request.data["text_input"] != true {
            request.actions = template.actions;
        }
        request.validate()?;
        let dedupe = request.dedupe_key.as_ref().map(|key| {
            format!(
                "{}:{}:{}:{key}",
                request.source.job_id.as_deref().unwrap_or(""),
                request.source.pane_id.as_deref().unwrap_or(""),
                request.source.session_id.as_deref().unwrap_or("")
            )
        });
        let conn = self.conn.lock();
        if let Some(key) = &dedupe {
            let raw: Option<String> = conn.query_row("SELECT record FROM notifications WHERE dedupe=?1 AND status IN ('pending','delivering')", [key], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
            if let Some(raw) = raw {
                let mut record: NfnRecord =
                    serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                if record.status == "pending" {
                    let mut channels = record.request.channels.clone();
                    if channels.is_empty() {
                        channels.push("desktop".into());
                    }
                    let incoming = if request.channels.is_empty() {
                        vec!["desktop".to_string()]
                    } else {
                        request.channels.clone()
                    };
                    for channel in incoming {
                        if !channels.contains(&channel) {
                            channels.push(channel);
                        }
                    }
                    request.channels = channels;
                    request.telegram_chat_id =
                        request.telegram_chat_id.or(record.request.telegram_chat_id);
                    record.request = request;
                    record.updated_at = now();
                    Self::write(&conn, &record)?;
                }
                return Ok((record, false));
            }
        }
        let timestamp = now();
        let status = if request.expires_at.is_some_and(|until| until <= timestamp) {
            "expired"
        } else {
            "pending"
        };
        let record = NfnRecord {
            id: uuid::Uuid::new_v4().to_string(),
            request,
            status: status.into(),
            response: None,
            created_at: timestamp,
            updated_at: timestamp,
            read_at: None,
            dismissed_at: None,
            error: None,
            question_id,
            deliveries: Default::default(),
        };
        conn.execute("INSERT INTO notifications(id,status,dedupe,record,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![record.id, record.status, dedupe, serde_json::to_string(&record).map_err(|e| e.to_string())?, record.created_at, record.updated_at]).map_err(|e| e.to_string())?;
        Ok((record, true))
    }

    fn write(conn: &Connection, record: &NfnRecord) -> Result<(), String> {
        conn.execute(
            "UPDATE notifications SET status=?2,record=?3,updated_at=?4 WHERE id=?1",
            params![
                record.id,
                record.status,
                serde_json::to_string(record).map_err(|e| e.to_string())?,
                record.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save(&self, record: &mut NfnRecord) -> Result<(), String> {
        record.updated_at = now();
        Self::write(&self.conn.lock(), record)
    }

    pub fn dismiss_many(&self, ids: &[String]) -> Result<Vec<NfnRecord>, String> {
        let mut conn = self.conn.lock();
        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        let timestamp = now();
        let mut records = Vec::new();
        for id in ids {
            let raw: String = transaction
                .query_row(
                    "SELECT record FROM notifications WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            let mut record: NfnRecord = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            record.dismissed_at = Some(timestamp);
            record.read_at = Some(timestamp);
            record.updated_at = timestamp;
            Self::write(&transaction, &record)?;
            records.push(record);
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(records)
    }

    pub fn claim(&self, id: &str) -> Result<NfnRecord, String> {
        let mut record = self.get(id)?;
        if record.status != "pending" {
            return Err(format!("Request is {}", record.status));
        }
        record.status = "delivering".into();
        record.updated_at = now();
        let count = self.conn.lock().execute("UPDATE notifications SET status='delivering',record=?2,updated_at=?3 WHERE id=?1 AND status='pending'",
            params![id,serde_json::to_string(&record).map_err(|e| e.to_string())?,record.updated_at]).map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("A response is already being delivered".into());
        }
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> NfnRequest {
        NfnRequest {
            title: "Review a post".into(),
            template: "social-review".into(),
            dedupe_key: Some("draft-1".into()),
            ..Default::default()
        }
    }
    #[test]
    fn viewing_deduplication_and_claiming_preserve_the_decision() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let (mut first, created) = store.send(request(), None).unwrap();
        assert!(created);
        first.read_at = Some(now());
        first.dismissed_at = Some(now());
        store.save(&mut first).unwrap();
        let mut update = request();
        update.body = "Revised caption".into();
        let (second, created) = store.send(update, None).unwrap();
        assert!(!created);
        assert_eq!(first.id, second.id);
        assert!(second.pending());
        assert!(second.read_at.is_some());
        store.claim(&second.id).unwrap();
        assert!(store.claim(&second.id).is_err());
    }

    #[test]
    fn channel_merging_preserves_delivery_and_dismissal_state() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let (mut first, _) = store.send(request(), None).unwrap();
        first.deliveries.insert(
            "mobile".into(),
            MessageDelivery {
                status: "sent".into(),
                updated_at: now(),
                ..Default::default()
            },
        );
        first.dismissed_at = Some(now());
        store.save(&mut first).unwrap();
        let mut telegram = request();
        telegram.channels = vec!["telegram".into()];
        telegram.telegram_chat_id = Some(123);
        let (merged, created) = store.send(telegram, None).unwrap();
        assert!(!created);
        assert_eq!(merged.id, first.id);
        assert_eq!(merged.request.channels, vec!["desktop", "telegram"]);
        assert_eq!(merged.deliveries, first.deliveries);
        assert_eq!(merged.dismissed_at, first.dismissed_at);
        assert_eq!(merged.request.telegram_chat_id, Some(123));
    }

    #[test]
    fn telegram_cleanup_finds_old_resolved_records_beyond_the_first_page() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let (mut first, _) = store.send(request(), None).unwrap();
        first.created_at = 1;
        first.status = "resolved".into();
        first.deliveries.insert(
            "telegram:123".into(),
            MessageDelivery {
                status: "closing".into(),
                target: Some(123),
                ..Default::default()
            },
        );
        store.save(&mut first).unwrap();
        for i in 0..60 {
            if i == 0 {
                store
                    .conn
                    .lock()
                    .execute(
                        "UPDATE notifications SET created_at=1 WHERE id=?1",
                        [&first.id],
                    )
                    .unwrap();
            }
            let mut newer = request();
            newer.dedupe_key = Some(format!("new-{i}"));
            store.send(newer, None).unwrap();
        }
        assert!(!store
            .list(0)
            .unwrap()
            .iter()
            .any(|record| record.id == first.id));
        assert_eq!(store.deliveries_to_close().unwrap()[0].id, first.id);
    }
    #[test]
    fn interrupted_delivery_is_not_replayed_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nfn.sqlite");
        let id = {
            let store = Store::open(&path).unwrap();
            let (record, _) = store.send(request(), None).unwrap();
            store.claim(&record.id).unwrap();
            record.id
        };
        let store = Store::open(&path).unwrap();
        let record = store.get(&id).unwrap();
        assert_eq!(record.status, "cancelled");
        assert!(record.error.is_some());
        assert!(store.pending().unwrap().is_empty());
    }

    #[test]
    fn pending_and_resolved_results_survive_restart_without_cancelling_a_wait() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nfn.sqlite");
        let (pending_id, resolved_id) = {
            let store = Store::open(&path).unwrap();
            let (pending, _) = store.send(request(), None).unwrap();
            let mut second = request();
            second.dedupe_key = Some("draft-2".into());
            let (record, _) = store.send(second, None).unwrap();
            let mut claimed = store.claim(&record.id).unwrap();
            claimed.status = "resolved".into();
            claimed.response = Some(NfnResponse {
                request_id: record.id.clone(),
                action_id: "approve".into(),
                text: Some("Ship this caption".into()),
                status: "resolved".into(),
                responded_at: now(),
            });
            store.save(&mut claimed).unwrap();
            (pending.id, record.id)
        };
        let store = Store::open(&path).unwrap();
        assert_eq!(store.get(&pending_id).unwrap().status, "pending");
        let result = store.get(&resolved_id).unwrap().response.unwrap();
        assert_eq!(result.action_id, "approve");
        assert_eq!(result.text.as_deref(), Some("Ship this caption"));
        assert!(store.claim(&resolved_id).is_err());
    }

    #[test]
    fn pending_queue_is_paged_and_hidden_requests_remain_in_history() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        for i in 0..123 {
            let mut value = request();
            value.dedupe_key = Some(i.to_string());
            store.send(value, None).unwrap();
        }
        assert_eq!(store.pending_count().unwrap(), 123);
        assert_eq!(store.pending_page(0).unwrap().len(), 50);
        assert_eq!(store.pending_page(100).unwrap().len(), 23);
        let mut hidden = store.pending_page(0).unwrap().remove(0);
        hidden.dismissed_at = Some(now());
        store.save(&mut hidden).unwrap();
        assert_eq!(store.pending_count().unwrap(), 122);
        assert_eq!(store.get(&hidden.id).unwrap().status, "pending");
        let mut expired = request();
        expired.dedupe_key = Some("expired".into());
        expired.expires_at = Some(now() - 1);
        assert_eq!(store.send(expired, None).unwrap().0.status, "expired");
    }

    #[test]
    fn deduplication_is_scoped_to_the_originating_session() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut first = request();
        first.source.session_id = Some("session-1".into());
        let mut second = first.clone();
        second.source.session_id = Some("session-2".into());
        let first = store.send(first, None).unwrap().0;
        let second = store.send(second, None).unwrap();
        assert!(second.1);
        assert_ne!(first.id, second.0.id);
    }

    #[test]
    fn bulk_dismiss_is_atomic_and_keeps_decisions_and_history() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let first = store.send(request(), None).unwrap().0;
        let mut second_request = request();
        second_request.dedupe_key = Some("second".into());
        let second = store.send(second_request, None).unwrap().0;
        assert!(store
            .dismiss_many(&[first.id.clone(), "missing".into()])
            .is_err());
        assert_eq!(store.pending_count().unwrap(), 2);
        assert!(store.get(&first.id).unwrap().dismissed_at.is_none());
        let dismissed = store
            .dismiss_many(&[first.id.clone(), second.id.clone()])
            .unwrap();
        assert_eq!(store.pending_count().unwrap(), 0);
        assert_eq!(store.list(0).unwrap().len(), 2);
        assert!(dismissed.iter().all(|record| record.status == "pending"
            && record.dismissed_at.is_some()
            && record.response.is_none()));
    }
}
