use super::{templates, types::*};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};

fn merge_preview_data(target: &mut serde_json::Value, patch: serde_json::Value) {
    if let serde_json::Value::Object(fields) = patch {
        if !target.is_object() {
            *target = serde_json::json!({});
        }
        for (key, value) in fields {
            merge_preview_data(&mut target[&key], value);
        }
    } else {
        *target = patch;
    }
}

// Delivery updates and automatic superseding are not human interactions.
const HISTORY_ORDER: &str = "MAX(COALESCE(json_extract(record,'$.dismissed_at'),0), COALESCE(json_extract(record,'$.response.responded_at'),0)) DESC, created_at DESC, id";

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
            CREATE INDEX IF NOT EXISTS nfn_scheduled_due ON notifications(json_extract(record,'$.request.deliver_at')) WHERE status='scheduled';
            CREATE UNIQUE INDEX IF NOT EXISTS nfn_active_dedupe ON notifications(dedupe)
                WHERE status IN ('pending', 'delivering') AND dedupe IS NOT NULL;
            CREATE TABLE IF NOT EXISTS ignored_agents (key TEXT PRIMARY KEY, record TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ignored_job_successes (job_id TEXT PRIMARY KEY);",
        )
        .map_err(|e| e.to_string())?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.recover_outreach_drafts()?;
        // An interrupted dispatch is never replayed into an agent after restart.
        for mut record in store.list_where("status = 'delivering'", 0, 10000)? {
            record.status = "cancelled".into();
            record.error = Some(
                "Daemon restarted during delivery; check the agent before submitting again".into(),
            );
            store.save(&mut record)?;
        }
        store.conn.lock().execute("DELETE FROM notifications WHERE status NOT IN ('pending', 'delivering', 'scheduled') AND updated_at < ?1", [now() - 30 * 86400000]).map_err(|e| e.to_string())?;
        Ok(store)
    }

    fn recover_outreach_drafts(&self) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        transaction
            .execute_batch("CREATE TABLE IF NOT EXISTS nfn_migrations (name TEXT PRIMARY KEY);")
            .map_err(|e| e.to_string())?;
        let first = transaction
            .execute(
                "INSERT OR IGNORE INTO nfn_migrations VALUES ('independent-outreach-drafts')",
                [],
            )
            .map_err(|e| e.to_string())?;
        if first == 1 {
            transaction.execute("UPDATE notifications SET status='pending', record=json_set(record,'$.status','pending','$.read_at',NULL,'$.updated_at',?1), updated_at=?1 WHERE status='superseded' AND json_type(record,'$.request.data.outreach')='object' AND json_extract(record,'$.dismissed_at') IS NULL AND json_extract(record,'$.response') IS NULL AND (dedupe IS NULL OR NOT EXISTS (SELECT 1 FROM notifications AS other WHERE other.id != notifications.id AND other.dedupe=notifications.dedupe AND (other.status IN ('pending','delivering') OR (other.created_at,other.id) > (notifications.created_at,notifications.id))))", [now()]).map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())
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
        self.list_where_ordered(clause, offset, limit, "created_at DESC, id")
    }

    fn list_where_ordered(
        &self,
        clause: &str,
        offset: usize,
        limit: usize,
        order: &str,
    ) -> Result<Vec<NfnRecord>, String> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare(&format!("SELECT record FROM notifications WHERE {clause} ORDER BY {order} LIMIT ?1 OFFSET ?2")).map_err(|e| e.to_string())?;
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
        self.list_where("status != 'scheduled'", offset, 50)
    }
    pub fn scheduled(&self, offset: usize) -> Result<Vec<NfnRecord>, String> {
        self.list_where("status = 'scheduled'", offset, 50)
    }

    pub fn activate_due(&self, timestamp: i64) -> Result<Vec<NfnRecord>, String> {
        let mut conn = self.conn.lock();
        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        let rows = {
            let mut statement = transaction.prepare("SELECT record FROM notifications WHERE status='scheduled' AND json_extract(record,'$.request.deliver_at') <= ?1 ORDER BY json_extract(record,'$.request.deliver_at') LIMIT 100").map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([timestamp], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let mut due = Vec::new();
        for row in rows {
            let mut record: NfnRecord = serde_json::from_str(&row).map_err(|e| e.to_string())?;
            record.status = if record
                .request
                .expires_at
                .is_some_and(|until| until <= timestamp)
            {
                "expired"
            } else {
                "pending"
            }
            .into();
            record.created_at = timestamp;
            record.updated_at = timestamp;
            Self::write(&transaction, &record)?;
            due.push(record);
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(due)
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

    pub fn search(
        &self,
        offset: usize,
        pending_only: bool,
        query: &str,
    ) -> Result<Vec<NfnRecord>, String> {
        if query.trim().is_empty() {
            return if pending_only {
                self.pending_page(offset)
            } else {
                self.list_where_ordered("status != 'scheduled'", offset, 50, HISTORY_ORDER)
            };
        }
        let mut clause = if pending_only {
            "status IN ('pending','delivering') AND json_extract(record,'$.dismissed_at') IS NULL AND COALESCE(json_extract(record,'$.ignored'),0)=0".to_owned()
        } else {
            "status != 'scheduled'".to_owned()
        };
        let mut values: Vec<rusqlite::types::Value> = vec![(50_i64).into(), (offset as i64).into()];
        for term in query.split_whitespace() {
            values.push(term.to_owned().into());
            clause.push_str(&format!(" AND EXISTS (SELECT 1 FROM json_tree(notifications.record,'$.request') WHERE type='text' AND instr(lower(atom),lower(?{}))>0)", values.len()));
        }
        let order = if pending_only {
            "created_at DESC, id"
        } else {
            HISTORY_ORDER
        };
        let conn = self.conn.lock();
        let mut statement = conn.prepare(&format!("SELECT record FROM notifications WHERE {clause} ORDER BY {order} LIMIT ?1 OFFSET ?2")).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
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
        request.title = clawtab_protocol::notification_text(&request.title);
        request.body = clawtab_protocol::notification_text(&request.body);
        for action in &mut request.actions {
            action.label = clawtab_protocol::notification_text(&action.label);
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
        let ignored = Self::request_ignored(&conn, &request)?;
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
                    record.ignored = ignored;
                    record.updated_at = now();
                    Self::write(&conn, &record)?;
                }
                return Ok((record, false));
            }
        }
        let timestamp = now();
        let status = if request.expires_at.is_some_and(|until| until <= timestamp) {
            "expired"
        } else if request.deliver_at.is_some() {
            "scheduled"
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
            "UPDATE notifications SET status=?2,record=?3,updated_at=?4,created_at=?5 WHERE id=?1",
            params![
                record.id,
                record.status,
                serde_json::to_string(record).map_err(|e| e.to_string())?,
                record.updated_at,
                record.created_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update(&self, id: &str, patch: NfnUpdate) -> Result<NfnRecord, String> {
        let mut conn = self.conn.lock();
        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        let raw: String = transaction
            .query_row(
                "SELECT record FROM notifications WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut record: NfnRecord = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if record.status != "pending" || record.dismissed_at.is_some() || record.response.is_some()
        {
            return Err("Only pending, undismissed messages can be updated".into());
        }
        if record.question_id.is_some()
            || record.request.needs_response()
            || record.request.template == "social-review"
        {
            return Err("Approval and question content is fixed; send a new review".into());
        }
        let outreach = record.request.data["outreach"].is_object();
        if let Some(title) = patch.title {
            record.request.title = clawtab_protocol::notification_text(&title);
        }
        if let Some(body) = patch.body {
            record.request.body = clawtab_protocol::notification_text(&body);
        }
        if let Some(data) = patch.data {
            if !data.is_object() {
                return Err("Message data patch must be an object".into());
            }
            merge_preview_data(&mut record.request.data, data);
        }
        if let Some(media) = patch.media {
            record.request.media = media;
        }
        if outreach && !record.request.data["outreach"].is_object() {
            return Err("An outreach preview must keep its outreach data".into());
        }
        record.request.validate()?;
        record.updated_at = now();
        record.read_at = None;
        Self::write(&transaction, &record)?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(record)
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
            if record.request.deliver_at.is_some() && record.pending() {
                record.status = "resolved".into();
            } else if record.status == "scheduled" {
                record.status = "cancelled".into();
            }
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
        // Reviews are independent work items, even when they share an agent thread.
        if latest.request.independent_review() || latest.request.deliver_at.is_some() {
            return Ok(Vec::new());
        }
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
                || record.request.independent_review()
                || record.request.deliver_at.is_some()
                || (record.created_at, &record.id) > (latest.created_at, &latest.id)
                || !latest.request.source.same_thread(&record.request.source)
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

    fn request_ignored(conn: &Connection, request: &NfnRequest) -> Result<bool, String> {
        let agent = request.source.agent_key();
        let job = request
            .source
            .job_id
            .as_deref()
            .filter(|_| request.message_kind() == "completed");
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM ignored_agents WHERE key=?1) OR EXISTS(SELECT 1 FROM ignored_job_successes WHERE job_id=?2)",
            params![agent, job], |row| row.get(0),
        ).map_err(|e| e.to_string())
    }

    pub fn ignored_job_successes(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock();
        let mut statement = conn
            .prepare("SELECT job_id FROM ignored_job_successes ORDER BY job_id")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn set_job_success_ignored(
        &self,
        job_id: &str,
        ignored: bool,
    ) -> Result<Vec<NfnRecord>, String> {
        if job_id.trim().is_empty() {
            return Err("Pass a job ID".into());
        }
        let mut conn = self.conn.lock();
        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        if ignored {
            transaction.execute(
                "INSERT OR IGNORE INTO ignored_job_successes(job_id) VALUES(?1)",
                [job_id],
            )
        } else {
            transaction.execute(
                "DELETE FROM ignored_job_successes WHERE job_id=?1",
                [job_id],
            )
        }
        .map_err(|e| e.to_string())?;
        let pending = {
            let mut statement = transaction.prepare("SELECT record FROM notifications WHERE status IN ('pending','delivering','scheduled') AND json_extract(record,'$.request.source.job_id')=?1").map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([job_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let mut changed = Vec::new();
        for raw in pending {
            let mut record: NfnRecord = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let ignored = Self::request_ignored(&transaction, &record.request)?;
            if record.ignored != ignored {
                record.ignored = ignored;
                record.updated_at = now();
                Self::write(&transaction, &record)?;
                changed.push(record);
            }
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(changed)
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
                record.ignored = Self::request_ignored(&transaction, &record.request)?;
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

    fn outreach_request() -> NfnRequest {
        NfnRequest {
            title: "Draft reply".into(),
            template: "update".into(),
            kind: "update".into(),
            data: serde_json::json!({"outreach":{"body":"Original copy","recipient":"founder","source_url":"https://example.com/post"}}),
            source: NfnSource {
                session_id: Some("research-session".into()),
                provider: Some("codex".into()),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn outreach_drafts_are_independent_of_summaries_and_each_other() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let (first, _) = store.send(outreach_request(), None).unwrap();
        let (second, _) = store.send(outreach_request(), None).unwrap();
        let mut summary = outreach_request();
        summary.data = serde_json::json!({});
        let (summary, _) = store.send(summary, None).unwrap();
        store.dismiss_many(&[summary.id.clone()]).unwrap();
        assert!(store.supersede_previous(&summary).unwrap().is_empty());
        store.dismiss_many(&[second.id.clone()]).unwrap();
        assert!(store.supersede_previous(&second).unwrap().is_empty());
        assert_eq!(store.get(&first.id).unwrap().status, "pending");
        assert!(store.get(&first.id).unwrap().dismissed_at.is_none());
        assert_eq!(store.pending_count().unwrap(), 1);
    }

    #[test]
    fn preview_updates_keep_identity_position_and_source_and_merge_nested_data() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let (original, _) = store.send(outreach_request(), None).unwrap();
        let updated = store
            .update(
                &original.id,
                NfnUpdate {
                    data: Some(serde_json::json!({"outreach":{"body":"Revised copy"}})),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.id, original.id);
        assert_eq!(updated.created_at, original.created_at);
        assert_eq!(
            updated.request.source.session_id,
            original.request.source.session_id
        );
        assert_eq!(updated.request.data["outreach"]["body"], "Revised copy");
        assert_eq!(updated.request.data["outreach"]["recipient"], "founder");
        assert_eq!(
            updated.request.data["outreach"]["source_url"],
            "https://example.com/post"
        );
        assert_eq!(store.list(0).unwrap().len(), 1);
        assert!(store
            .update(
                &original.id,
                NfnUpdate {
                    title: Some("".into()),
                    ..Default::default()
                }
            )
            .is_err());
        assert_eq!(
            store.get(&original.id).unwrap().request.title,
            "Draft reply"
        );
        store.dismiss_many(&[original.id.clone()]).unwrap();
        assert!(store.update(&original.id, NfnUpdate::default()).is_err());
        let (approval, _) = store.send(request(), None).unwrap();
        assert!(store.update(&approval.id, NfnUpdate::default()).is_err());
        assert!(serde_json::from_value::<NfnUpdate>(serde_json::json!({"source":{}})).is_err());
    }

    #[test]
    fn recovery_restores_only_accidentally_superseded_outreach_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notifications.sqlite");
        let store = Store::open(&path).unwrap();
        let (mut lost, _) = store.send(outreach_request(), None).unwrap();
        lost.status = "superseded".into();
        store.save(&mut lost).unwrap();
        let (mut dismissed, _) = store.send(outreach_request(), None).unwrap();
        dismissed.status = "superseded".into();
        dismissed.dismissed_at = Some(now());
        store.save(&mut dismissed).unwrap();
        // Simulate a database written before the recovery migration existed.
        store
            .conn
            .lock()
            .execute("DELETE FROM nfn_migrations", [])
            .unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.get(&lost.id).unwrap().status, "pending");
        assert_eq!(store.get(&dismissed.id).unwrap().status, "superseded");
        lost.status = "superseded".into();
        store.save(&mut lost).unwrap();
        drop(store);
        assert_eq!(
            Store::open(&path).unwrap().get(&lost.id).unwrap().status,
            "superseded"
        );
    }

    #[test]
    fn recovery_preserves_replacements_with_the_same_dedupe_key() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut draft = outreach_request();
        draft.dedupe_key = Some("crm-outreach-card:message".into());
        let (mut old, _) = store.send(draft.clone(), None).unwrap();
        old.status = "superseded".into();
        store.save(&mut old).unwrap();
        let (replacement, _) = store.send(draft, None).unwrap();
        store
            .conn
            .lock()
            .execute("DELETE FROM nfn_migrations", [])
            .unwrap();
        store.recover_outreach_drafts().unwrap();
        assert_eq!(store.get(&old.id).unwrap().status, "superseded");
        assert_eq!(store.get(&replacement.id).unwrap().status, "pending");
    }
    #[test]
    fn strips_terminal_codes_before_storing_or_updating_messages() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        for text in ["\x1b[31mReview\x1b[0m", "[2m[38;2;99;168;248mReview[39m"] {
            let (record, _) = store
                .send(
                    NfnRequest {
                        title: text.into(),
                        body: text.into(),
                        dedupe_key: Some("color-test".into()),
                        actions: vec![NfnAction {
                            id: "review".into(),
                            label: text.into(),
                            ..Default::default()
                        }],
                        ..Default::default()
                    },
                    None,
                )
                .unwrap();
            let saved = store.get(&record.id).unwrap();
            assert_eq!(saved.request.title, "Review");
            assert_eq!(saved.request.body, "Review");
            assert_eq!(saved.request.actions[0].label, "Review");
        }
    }

    #[test]
    fn reminders_wait_until_due_and_survive_restarts_without_early_delivery() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notifications.sqlite");
        let due = now() + 86400000;
        let id = {
            let store = Store::open(&path).unwrap();
            let (record, _) = store
                .send(
                    NfnRequest {
                        kind: "update".into(),
                        template: "update".into(),
                        title: "Check embeddings".into(),
                        deliver_at: Some(due),
                        ..Default::default()
                    },
                    None,
                )
                .unwrap();
            assert_eq!(record.status, "scheduled");
            assert!(store.list(0).unwrap().is_empty());
            assert!(store.search(0, false, "embeddings").unwrap().is_empty());
            assert_eq!(store.pending_count().unwrap(), 0);
            assert!(store.activate_due(due - 1).unwrap().is_empty());
            record.id
        };
        let store = Store::open(&path).unwrap();
        assert_eq!(store.scheduled(0).unwrap()[0].id, id);
        let delivered = store.activate_due(due + 3600000).unwrap();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].status, "pending");
        assert_eq!(delivered[0].id, id);
        assert!(store.activate_due(due + 3600001).unwrap().is_empty());
        assert_eq!(store.pending_count().unwrap(), 1);
        store.dismiss_many(&[id.clone()]).unwrap();
        assert_eq!(store.get(&id).unwrap().status, "resolved");
    }

    #[test]
    fn cancelled_schedules_do_not_fire_and_expired_schedules_are_not_pending() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let due = now() + 1000;
        let request = NfnRequest {
            kind: "update".into(),
            template: "update".into(),
            title: "Reminder".into(),
            deliver_at: Some(due),
            ..Default::default()
        };
        let (cancelled, _) = store.send(request.clone(), None).unwrap();
        store.dismiss_many(&[cancelled.id.clone()]).unwrap();
        let (expired, _) = store
            .send(
                NfnRequest {
                    expires_at: Some(due + 1),
                    ..request
                },
                None,
            )
            .unwrap();
        let due = store.activate_due(due + 2).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, expired.id);
        assert_eq!(due[0].status, "expired");
        assert_eq!(store.get(&cancelled.id).unwrap().status, "cancelled");
        assert!(store.pending().unwrap().is_empty());
    }

    fn request() -> NfnRequest {
        NfnRequest {
            title: "Review a post".into(),
            template: "social-review".into(),
            dedupe_key: Some("draft-1".into()),
            ..Default::default()
        }
    }
    #[test]
    fn history_orders_interactions_before_newer_messages_and_before_pagination() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut ids = Vec::new();
        for index in 0..55 {
            let (mut record, _) = store
                .send(
                    NfnRequest {
                        title: format!("History {index}"),
                        dedupe_key: None,
                        ..request()
                    },
                    None,
                )
                .unwrap();
            record.created_at = 100 + index;
            match index {
                0 => record.dismissed_at = Some(300),
                1 | 2 => {
                    record.response = Some(NfnResponse {
                        request_id: record.id.clone(),
                        action_id: "approve".into(),
                        text: None,
                        decisions: None,
                        status: "resolved".into(),
                        responded_at: 300 + index * 100,
                    });
                    if index == 2 {
                        record.dismissed_at = Some(200);
                    }
                }
                54 => {
                    record.read_at = Some(900);
                    record.status = "superseded".into();
                }
                _ => {}
            }
            store.save(&mut record).unwrap();
            ids.push(record.id);
        }
        let expected = [ids[2].clone(), ids[1].clone(), ids[0].clone()];
        for query in ["", "History"] {
            let first = store.search(0, false, query).unwrap();
            assert_eq!(first.len(), 50);
            assert_eq!(
                first[..3].iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
                expected
            );
            assert_eq!(first[3].id, ids[54]);
            let second = store.search(50, false, query).unwrap();
            assert_eq!(second.len(), 5);
            assert!(second
                .iter()
                .all(|r| first.iter().all(|other| other.id != r.id)));
        }
        assert_eq!(store.search(0, true, "History").unwrap()[0].id, ids[53]);
    }

    #[test]
    fn search_matches_content_and_source_before_pagination_and_respects_pending_scope() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let mut ids = Vec::new();
        for index in 0..53 {
            let (mut record, _) = store
                .send(
                    NfnRequest {
                        title: format!("Message #{index}"),
                        body: "Review 100%_ready \"caption\"".into(),
                        source: NfnSource {
                            cwd: Some("/projects/Clawtab".into()),
                            ..Default::default()
                        },
                        dedupe_key: None,
                        ..request()
                    },
                    None,
                )
                .unwrap();
            record.created_at = now() + index;
            if index == 52 {
                record.dismissed_at = Some(now());
            }
            if index == 51 {
                record.ignored = true;
            }
            if index == 50 {
                record.status = "resolved".into();
            }
            store.save(&mut record).unwrap();
            ids.push(record.id);
        }
        assert_eq!(
            store
                .search(0, false, "MESSAGE #0 clawtab caption")
                .unwrap()[0]
                .id,
            ids[0]
        );
        assert_eq!(store.search(0, false, "100%_ready").unwrap().len(), 50);
        assert_eq!(store.search(50, false, "100%_ready").unwrap().len(), 3);
        let pending = store.search(0, true, "clawtab").unwrap();
        assert_eq!(pending.len(), 50);
        assert!(pending.iter().all(|record| !ids[50..].contains(&record.id)));
        assert!(store.search(0, true, "missing").unwrap().is_empty());
        assert!(store.search(0, false, "' OR 1=1 --").unwrap().is_empty());
    }
    #[test]
    fn handling_latest_supersedes_only_earlier_messages_from_the_same_agent() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let base = now() + 100;
        let send = |pane: &str, session: &str, time: i64| {
            let request = NfnRequest {
                template: "update".into(),
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
    fn publication_reviews_are_not_superseded_by_agent_messages_or_other_reviews() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let base = now() + 100;
        let send = |template: &str, time: i64| {
            let (mut record, _) = store
                .send(
                    NfnRequest {
                        template: template.into(),
                        source: NfnSource {
                            pane_id: Some("%20".into()),
                            session_id: Some("posting-agent".into()),
                            ..Default::default()
                        },
                        dedupe_key: None,
                        ..request()
                    },
                    None,
                )
                .unwrap();
            record.created_at = time;
            store.save(&mut record).unwrap();
            record
        };
        let update = send("update", base);
        let review = send("social-review", base + 1);
        let next_review = send("social-review", base + 2);
        assert!(store.supersede_previous(&next_review).unwrap().is_empty());
        assert_eq!(store.get(&update.id).unwrap().status, "pending");
        let completion = send("update", base + 3);
        let closed = store.supersede_previous(&completion).unwrap();
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].id, update.id);
        for review in [&review, &next_review] {
            let saved = store.get(&review.id).unwrap();
            assert_eq!(saved.status, "pending");
            assert!(saved.response.is_none());
            assert!(saved.dismissed_at.is_none());
        }
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
    fn handling_latest_job_message_supersedes_earlier_runs_of_only_that_job() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let base = now() + 100;
        let send = |job: &str, run: Option<&str>, pane: Option<&str>, time: i64| {
            let request = NfnRequest {
                template: "update".into(),
                source: NfnSource {
                    job_id: Some(job.into()),
                    run_id: run.map(str::to_owned),
                    pane_id: pane.map(str::to_owned),
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
        let job = "journal/screenshot-inbox";
        let first = send(job, Some("run-a"), Some("%1"), base);
        let retry = send(job, Some("run-b"), Some("%2"), base + 1);
        let latest = send(job, None, None, base + 2);
        let newer = send(job, Some("run-c"), None, base + 3);
        let other_job = send(
            "journal/daily-content-brief",
            Some("run-a"),
            Some("%1"),
            base,
        );
        let mut delivering = send(job, Some("run-a"), None, base);
        delivering.status = "delivering".into();
        store.save(&mut delivering).unwrap();
        let closed = store.supersede_previous(&latest).unwrap();
        assert_eq!(closed.len(), 2);
        for record in [&first, &retry] {
            let record = store.get(&record.id).unwrap();
            assert_eq!(record.status, "superseded");
            assert!(record.read_at.is_some());
            assert!(record.response.is_none());
        }
        for record in [&latest, &newer, &other_job] {
            assert_eq!(store.get(&record.id).unwrap().status, "pending");
        }
        assert_eq!(store.get(&delivering.id).unwrap().status, "delivering");
        assert!(store.supersede_previous(&latest).unwrap().is_empty());
    }

    #[test]
    fn ignoring_job_successes_survives_restart_and_matches_static_job_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("messages.db");
        let store = Store::open(&path).unwrap();
        let mut success = NfnRequest {
            kind: "completed".into(),
            dedupe_key: None,
            source: NfnSource {
                job_id: Some("project/repair".into()),
                run_id: Some("run-a".into()),
                agent_title: Some("Original title".into()),
                ..Default::default()
            },
            ..request()
        };
        let (first, _) = store.send(success.clone(), None).unwrap();
        assert_eq!(
            store
                .set_job_success_ignored("project/repair", true)
                .unwrap()
                .len(),
            1
        );
        assert!(store.get(&first.id).unwrap().ignored);
        assert_eq!(store.pending_count().unwrap(), 0);
        drop(store);
        let store = Store::open(&path).unwrap();
        success.source.run_id = Some("run-b".into());
        success.source.agent_title = Some("Renamed title".into());
        let (next, _) = store.send(success.clone(), None).unwrap();
        assert!(next.ignored);
        for kind in ["failed", "update", "question", "approval"] {
            let (record, _) = store
                .send(
                    NfnRequest {
                        kind: kind.into(),
                        ..success.clone()
                    },
                    None,
                )
                .unwrap();
            assert!(!record.ignored, "{kind} must still be delivered");
        }
        let mut other = success.clone();
        other.source.job_id = Some("other/repair".into());
        assert!(!store.send(other, None).unwrap().0.ignored);
        assert_eq!(store.ignored_job_successes().unwrap(), ["project/repair"]);
        assert_eq!(
            store
                .set_job_success_ignored("project/repair", false)
                .unwrap()
                .len(),
            2
        );
        assert!(!store.get(&first.id).unwrap().ignored);
        assert!(!store.send(success, None).unwrap().0.ignored);
        assert!(store.ignored_job_successes().unwrap().is_empty());
    }

    #[test]
    fn job_success_and_agent_ignore_rules_can_be_removed_independently() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let (record, _) = store
            .send(
                NfnRequest {
                    kind: "completed".into(),
                    source: NfnSource {
                        job_id: Some("project/repair".into()),
                        run_id: Some("run-a".into()),
                        ..Default::default()
                    },
                    ..request()
                },
                None,
            )
            .unwrap();
        store
            .set_job_success_ignored("project/repair", true)
            .unwrap();
        store.set_ignored(&record.id, true).unwrap();
        store.set_ignored(&record.id, false).unwrap();
        assert!(store.get(&record.id).unwrap().ignored);
        store.set_ignored(&record.id, true).unwrap();
        store
            .set_job_success_ignored("project/repair", false)
            .unwrap();
        assert!(store.get(&record.id).unwrap().ignored);
        store.set_ignored(&record.id, false).unwrap();
        assert!(!store.get(&record.id).unwrap().ignored);
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
    fn concurrent_ignore_and_sends_leave_every_stored_message_ignored() {
        for round in 0..32 {
            let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
            let request = NfnRequest {
                dedupe_key: None,
                source: NfnSource {
                    pane_id: Some("%1".into()),
                    session_id: Some("session-a".into()),
                    agent_pid: Some("123".into()),
                    agent_started_at: Some(10),
                    ..Default::default()
                },
                ..request()
            };
            let seed = store.send(request.clone(), None).unwrap().0;
            let start = std::sync::Barrier::new(5);
            let ids = std::thread::scope(|threads| {
                let ignore = threads.spawn(|| {
                    start.wait();
                    std::thread::yield_now();
                    store.set_ignored(&seed.id, true).unwrap();
                });
                let senders = (0..4)
                    .map(|_| {
                        threads.spawn(|| {
                            start.wait();
                            (0..8)
                                .map(|_| {
                                    let (record, created) =
                                        store.send(request.clone(), None).unwrap();
                                    assert!(created);
                                    std::thread::yield_now();
                                    record.id
                                })
                                .collect::<Vec<_>>()
                        })
                    })
                    .collect::<Vec<_>>();
                ignore.join().unwrap();
                senders
                    .into_iter()
                    .flat_map(|sender| sender.join().unwrap())
                    .collect::<Vec<_>>()
            });
            assert_eq!(ids.len(), 32);
            // A send may return before Ignore commits; inspect stored state after both finish.
            for id in ids {
                let record = store.get(&id).unwrap();
                assert!(record.ignored, "round {round}, message {id}");
                assert_eq!(record.status, "pending");
                assert!(record.response.is_none());
            }
            assert_eq!(store.pending().unwrap().len(), 33);
            assert_eq!(store.pending_count().unwrap(), 0);
        }
    }

    #[test]
    fn deduplication_refreshes_ignore_when_agent_identity_changes() {
        for changed_field in ["pid", "started_at", "run_id"] {
            let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
            let original = NfnRequest {
                source: NfnSource {
                    pane_id: Some("%1".into()),
                    session_id: Some("session-a".into()),
                    agent_pid: Some("123".into()),
                    agent_started_at: Some(10),
                    run_id: Some("run-a".into()),
                    ..Default::default()
                },
                ..request()
            };
            let first = store.send(original.clone(), None).unwrap().0;
            let mut replacement = original.clone();
            match changed_field {
                "pid" => replacement.source.agent_pid = Some("456".into()),
                "started_at" => replacement.source.agent_started_at = Some(20),
                "run_id" => replacement.source.run_id = Some("run-b".into()),
                _ => unreachable!(),
            }
            let mut seed = replacement.clone();
            seed.dedupe_key = None;
            let ignored = store.send(seed, None).unwrap().0;
            store.set_ignored(&ignored.id, true).unwrap();
            assert!(!store.get(&first.id).unwrap().ignored);

            let (updated, created) = store.send(replacement.clone(), None).unwrap();
            assert!(!created);
            assert_eq!(updated.id, first.id);
            assert!(
                updated.ignored,
                "replacement must use ignored {changed_field}"
            );
            assert_eq!(updated.request.source, replacement.source);
            assert!(store.get(&first.id).unwrap().ignored);
            assert_eq!(store.pending_count().unwrap(), 0);

            let (restored, created) = store.send(original, None).unwrap();
            assert!(!created);
            assert_eq!(restored.id, first.id);
            assert!(
                !restored.ignored,
                "original {changed_field} remains unignored"
            );
            assert_eq!(restored.status, "pending");
            assert!(restored.response.is_none());
            assert!(store.get(&ignored.id).unwrap().ignored);
            assert_eq!(store.pending_count().unwrap(), 1);
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
                decisions: None,
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
