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
                WHERE status IN ('pending', 'delivering') AND dedupe IS NOT NULL;
            CREATE TABLE IF NOT EXISTS ignored_agents (key TEXT PRIMARY KEY, record TEXT NOT NULL);",
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
        self.conn.lock().query_row("SELECT count(*) FROM notifications WHERE status IN ('pending','delivering') AND json_extract(record,'$.dismissed_at') IS NULL AND COALESCE(json_extract(record,'$.ignored'),0)=0", [], |row| row.get(0)).map_err(|e| e.to_string())
    }
    pub fn pending_page(&self, offset: usize) -> Result<Vec<NfnRecord>, String> {
        self.list_where(
            "status IN ('pending','delivering') AND json_extract(record,'$.dismissed_at') IS NULL AND COALESCE(json_extract(record,'$.ignored'),0)=0",
            offset,
            50,
        )
    }
    pub fn pending(&self) -> Result<Vec<NfnRecord>, String> {
        self.list_where("status IN ('pending', 'delivering')", 0, 2000)
    }

    pub fn deliveries_to_close(&self) -> Result<Vec<NfnRecord>, String> {
        self.list_where(
            "(status NOT IN ('pending','delivering') OR json_extract(record,'$.dismissed_at') IS NOT NULL OR json_extract(record,'$.ignored')=1)
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
        let ignored = self
            .ignored_agents()?
            .iter()
            .any(|agent| agent.source.same_agent(&request.source));
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
            ignored,
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

    pub fn save_delivery(
        &self,
        id: &str,
        channel: &str,
        delivery: &MessageDelivery,
    ) -> Result<(), String> {
        let path = format!("$.deliveries.\"{channel}\"");
        let value = serde_json::to_string(delivery).map_err(|error| error.to_string())?;
        self.conn.lock().execute(
            "UPDATE notifications SET record=json_set(record,?2,json(?3),'$.updated_at',?4),updated_at=?4 WHERE id=?1",
            params![id, path, value, now()],
        ).map_err(|error| error.to_string())?;
        Ok(())
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

    pub fn supersede_previous(&self, latest: &NfnRecord) -> Result<Vec<NfnRecord>, String> {
        let mut conn = self.conn.lock();
        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        let previous = {
            let mut statement = transaction.prepare(
                "SELECT record FROM notifications WHERE status='pending' AND created_at <= ?1 AND id != ?2",
            ).map_err(|e| e.to_string())?;
            let rows = statement
                .query_map(params![latest.created_at, latest.id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let mut superseded = Vec::new();
        for raw in previous {
            let mut record: NfnRecord = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            if record.dismissed_at.is_some()
                || (record.created_at, &record.id) > (latest.created_at, &latest.id)
                || !latest.request.source.same_agent(&record.request.source)
            {
                continue;
            }
            record.status = "superseded".into();
            record.read_at = Some(now());
            record.updated_at = now();
            Self::write(&transaction, &record)?;
            superseded.push(record);
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(superseded)
    }

    pub fn ignored_agents(&self) -> Result<Vec<IgnoredAgent>, String> {
        let conn = self.conn.lock();
        let mut statement = conn
            .prepare("SELECT record FROM ignored_agents ORDER BY rowid DESC")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }

    pub fn set_ignored(&self, id: &str, ignored: bool) -> Result<Vec<NfnRecord>, String> {
        let agent = if ignored {
            let record = self.get(id)?;
            IgnoredAgent {
                id: id.into(),
                source: record.request.source,
                title: record.request.title,
                ignored_at: now(),
            }
        } else {
            let source = self.get(id).ok().map(|record| record.request.source);
            self.ignored_agents()?
                .into_iter()
                .find(|agent| {
                    agent.id == id
                        || source
                            .as_ref()
                            .is_some_and(|source| source.same_agent(&agent.source))
                })
                .ok_or("Ignored agent not found")?
        };
        let key = agent
            .source
            .agent_key()
            .ok_or("This message has no agent")?;
        let mut conn = self.conn.lock();
        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        if ignored {
            transaction.execute("INSERT INTO ignored_agents(key,record) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET record=excluded.record",
                params![key, serde_json::to_string(&agent).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        } else {
            transaction
                .execute("DELETE FROM ignored_agents WHERE key=?1", [key])
                .map_err(|e| e.to_string())?;
        }
        let pending = {
            let mut statement = transaction
                .prepare(
                    "SELECT record FROM notifications WHERE status IN ('pending','delivering')",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let mut changed = Vec::new();
        for raw in pending {
            let mut record: NfnRecord = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            if agent.source.same_agent(&record.request.source) {
                record.ignored = ignored;
                record.updated_at = now();
                Self::write(&transaction, &record)?;
                changed.push(record);
            }
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(changed)
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
    fn handling_latest_supersedes_only_earlier_messages_from_the_same_agent() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let base = now() + 100;
        let send = |pane: &str, session: &str, time: i64| {
            let request = NfnRequest {
                source: NfnSource {
                    pane_id: Some(pane.into()),
                    session_id: Some(session.into()),
                    ..Default::default()
                },
                dedupe_key: None,
                ..request()
            };
            let (mut record, _) = store.send(request, None).unwrap();
            record.created_at = time;
            store.save(&mut record).unwrap();
            record
        };
        let first = send("%1", "session-a", base);
        let second = send("%1", "session-a", base + 1);
        let latest = send("%1", "session-a", base + 2);
        let newer = send("%1", "session-a", base + 3);
        let other_agent = send("%2", "session-a", base);
        let other_session = send("%1", "session-b", base);
        let mut delivering = send("%1", "session-a", base);
        delivering.status = "delivering".into();
        store.save(&mut delivering).unwrap();
        let closed = store.supersede_previous(&latest).unwrap();
        assert_eq!(closed.len(), 2);
        for record in [&first, &second] {
            let record = store.get(&record.id).unwrap();
            assert_eq!(record.status, "superseded");
            assert!(record.response.is_none());
        }
        for record in [&latest, &newer, &other_agent, &other_session] {
            assert_eq!(store.get(&record.id).unwrap().status, "pending");
        }
        assert_eq!(store.get(&delivering.id).unwrap().status, "delivering");
        assert!(store.supersede_previous(&latest).unwrap().is_empty());
    }

    #[test]
    fn messages_without_an_agent_are_independent_and_job_runs_stay_separate() {
        let unidentified = NfnSource::default();
        assert!(!unidentified.same_agent(&unidentified));
        let source = NfnSource {
            job_id: Some("daily".into()),
            run_id: Some("run-a".into()),
            ..Default::default()
        };
        assert!(source.same_agent(&source));
        let mut other = source.clone();
        other.run_id = Some("run-b".into());
        assert!(!source.same_agent(&other));
        let mut restarted = NfnSource {
            pane_id: Some("%1".into()),
            agent_pid: Some("123".into()),
            agent_started_at: Some(10),
            ..Default::default()
        };
        let before = restarted.clone();
        restarted.agent_started_at = Some(20);
        assert!(!before.same_agent(&restarted));
    }

    #[test]
    fn ignoring_an_agent_survives_restart_and_can_be_removed_after_its_message_is_deleted() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("messages.db");
        let request = NfnRequest {
            dedupe_key: None,
            source: NfnSource {
                pane_id: Some("%1".into()),
                session_id: Some("session-a".into()),
                ..Default::default()
            },
            ..request()
        };
        let store = Store::open(&path).unwrap();
        let (first, _) = store.send(request.clone(), None).unwrap();
        let (second, _) = store.send(request.clone(), None).unwrap();
        assert_eq!(store.set_ignored(&second.id, true).unwrap().len(), 2);
        assert_eq!(store.pending_count().unwrap(), 0);
        assert!(store.pending_page(0).unwrap().is_empty());
        assert_eq!(store.get(&first.id).unwrap().status, "pending");
        assert!(store.get(&first.id).unwrap().response.is_none());
        drop(store);

        let store = Store::open(&path).unwrap();
        let (third, _) = store.send(request.clone(), None).unwrap();
        assert!(third.ignored);
        let mut other_session = request;
        other_session.source.session_id = Some("session-b".into());
        let (other, _) = store.send(other_session, None).unwrap();
        assert!(!other.ignored);
        assert_eq!(store.pending_count().unwrap(), 1);
        store
            .conn
            .lock()
            .execute("DELETE FROM notifications WHERE id=?1", [&second.id])
            .unwrap();
        let restored = store.set_ignored(&second.id, false).unwrap();
        assert_eq!(restored.len(), 2);
        assert!(restored
            .iter()
            .all(|record| !record.ignored && record.pending()));
        assert!(store.ignored_agents().unwrap().is_empty());
        assert_eq!(store.pending_count().unwrap(), 3);
        assert!(store.set_ignored(&other.id, true).is_ok());
        assert_eq!(store.pending_count().unwrap(), 2);
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
    fn delivery_receipts_preserve_concurrent_channel_updates_and_dismissal() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let (original, _) = store.send(request(), None).unwrap();
        let mut telegram = request();
        telegram.channels = vec!["telegram".into()];
        store.send(telegram, None).unwrap();
        store.dismiss_many(&[original.id.clone()]).unwrap();
        let delivery = MessageDelivery {
            status: "sent".into(),
            updated_at: now(),
            ..Default::default()
        };
        store
            .save_delivery(&original.id, "mobile", &delivery)
            .unwrap();
        let current = store.get(&original.id).unwrap();
        assert_eq!(current.request.channels, vec!["desktop", "telegram"]);
        assert!(current.dismissed_at.is_some());
        assert_eq!(current.deliveries["mobile"], delivery);
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
