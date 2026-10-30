//! Read provider lifecycle evidence without capturing terminal contents.
use super::ProcessProvider;
use crate::agent_hooks::HookEventV1;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) struct Terminal {
    pub at_ms: u64,
    // Recovery changes status without replaying historical completion messages.
    pub event: &'static str,
}

fn terminal(at_ms: u64, hook_ms: u64, event: &'static str) -> Option<Terminal> {
    (at_ms > hook_ms).then_some(Terminal { at_ms, event })
}

pub(crate) async fn terminal_after(
    client: &reqwest::Client,
    event: &HookEventV1,
) -> Option<Terminal> {
    if event.provider == ProcessProvider::Opencode && event.status_url.is_some() {
        match opencode_status(client, event).await {
            Some(true) => {
                return terminal(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .ok()?
                        .as_millis() as u64,
                    event.occurred_at_ms,
                    "reconciled_idle",
                )
            }
            Some(false) => return None,
            None => {}
        }
    }
    let event = event.clone();
    tokio::task::spawn_blocking(move || match event.provider {
        ProcessProvider::Codex => {
            super::codex::completed_turn_after(&event.session_id, event.occurred_at_ms).map(
                |at_ms| Terminal {
                    at_ms,
                    event: "reconciled_idle",
                },
            )
        }
        ProcessProvider::Claude => claude_path(&event)
            .and_then(|path| claude_terminal(&path, &event.session_id, event.occurred_at_ms)),
        ProcessProvider::Opencode => open_db(&opencode_path())
            .and_then(|conn| opencode_terminal(&conn, &event.session_id, event.occurred_at_ms)),
        ProcessProvider::Hermes => {
            open_db(&Path::new(event.hermes_home.as_ref()?).join("state.db"))
                .and_then(|conn| hermes_terminal(&conn, &event.session_id, event.occurred_at_ms))
        }
        _ => None,
    })
    .await
    .ok()
    .flatten()
}

fn open_db(path: &Path) -> Option<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.busy_timeout(Duration::from_millis(50)).ok()?;
    // Bound queries even if a provider schema lacks the expected index.
    let deadline = std::time::Instant::now() + Duration::from_millis(50);
    conn.progress_handler(1_000, Some(move || std::time::Instant::now() >= deadline));
    Some(conn)
}

fn claude_root() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"))
}

fn claude_path(event: &HookEventV1) -> Option<PathBuf> {
    if !event
        .session_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return None;
    }
    let root = claude_root();
    // Hook cwd can change during a session. The PID record retains the original
    // project directory, including sessions resumed in a different directory.
    let record = event
        .process_id
        .and_then(|pid| std::fs::read(root.join("sessions").join(format!("{pid}.json"))).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let original = record
        .as_ref()
        .filter(|record| record["sessionId"].as_str() == Some(&event.session_id))
        .and_then(|record| record["cwd"].as_str());
    let cwd = original.or(event.cwd.as_deref())?;
    let project = cwd.replace(['/', '~'], "-").replace('.', "");
    Some(
        root.join("projects")
            .join(project)
            .join(format!("{}.jsonl", event.session_id)),
    )
}

fn timestamp_ms(value: &Value) -> Option<u64> {
    u64::try_from(
        chrono::DateTime::parse_from_rfc3339(value.get("timestamp")?.as_str()?)
            .ok()?
            .timestamp_millis(),
    )
    .ok()
}

fn claude_terminal(path: &Path, id: &str, hook_ms: u64) -> Option<Terminal> {
    const MAX_BYTES: u64 = 256 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let start = file.metadata().ok()?.len().saturating_sub(MAX_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES).read_to_end(&mut bytes).ok()?;
    if start > 0 {
        let first = bytes.iter().position(|byte| *byte == b'\n')?;
        bytes.drain(..=first);
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    if !text.ends_with('\n') {
        return None;
    }
    for line in text.lines().rev() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if value
            .get("sessionId")
            .or_else(|| value.get("session_id"))
            .and_then(Value::as_str)
            .is_some_and(|session| session != id)
        {
            continue;
        }
        let kind = value["type"].as_str().unwrap_or_default();
        let subtype = value["subtype"].as_str().unwrap_or_default();
        if kind == "user" {
            let interrupted = value.get("interruptedMessageId").is_some()
                && value
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .is_some_and(|parts| {
                        parts
                            .iter()
                            .any(|part| part["text"] == "[Request interrupted by user]")
                    });
            return if interrupted {
                terminal(timestamp_ms(&value)?, hook_ms, "reconciled_interrupted")
            } else {
                None
            };
        }
        if kind == "assistant" {
            let reason = value
                .pointer("/message/stop_reason")
                .and_then(Value::as_str)?;
            return match reason {
                "end_turn" | "stop_sequence" | "max_tokens" => {
                    terminal(timestamp_ms(&value)?, hook_ms, "reconciled_complete")
                }
                _ => None,
            };
        }
        // Housekeeping summaries can follow cancellation, so keep looking for
        // the explicit interruption or the final assistant response.
        if kind == "system" && subtype == "stop_hook_summary" {
            return terminal(timestamp_ms(&value)?, hook_ms, "reconciled_complete");
        }
    }
    None
}

fn opencode_path() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".local/share"))
        .join("opencode/opencode.db")
}

fn opencode_terminal(conn: &Connection, id: &str, hook_ms: u64) -> Option<Terminal> {
    let (role, completed, finish, error): (String, Option<u64>, Option<String>, Option<String>) = conn.query_row(
        "SELECT json_extract(data, '$.role'), json_extract(data, '$.time.completed'), json_extract(data, '$.finish'), json_extract(data, '$.error.name') FROM message WHERE session_id = ?1 ORDER BY time_created DESC, id DESC LIMIT 1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).ok()?;
    if role != "assistant" {
        return None;
    }
    let kind = if error.as_deref() == Some("MessageAbortedError") {
        "reconciled_interrupted"
    } else if error.is_some() {
        "reconciled_failed"
    } else if matches!(
        finish.as_deref(),
        Some("stop" | "length" | "content-filter")
    ) {
        "reconciled_complete"
    } else {
        return None;
    };
    terminal(completed?, hook_ms, kind)
}

fn table_exists(conn: &Connection, table: &str) -> Option<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
    .ok()
}

fn hermes_terminal(conn: &Connection, id: &str, hook_ms: u64) -> Option<Terminal> {
    conn.execute_batch("BEGIN").ok()?;
    for (table, query) in [
        ("session_admissions", "SELECT EXISTS(SELECT 1 FROM session_admissions WHERE target_session_id = ?1 AND status != 'terminal')"),
        ("worker_executions", "SELECT EXISTS(SELECT 1 FROM worker_executions WHERE session_id = ?1 AND status != 'terminal')"),
        ("session_turn_leases", "SELECT EXISTS(SELECT 1 FROM session_turn_leases WHERE conversation_id = ?1 AND expires_at > unixepoch())"),
    ] {
        if table_exists(conn, table)? && conn.query_row(query, [id], |row| row.get::<_, bool>(0)).ok()? { return None; }
    }
    let ended: Option<f64> = conn
        .query_row("SELECT ended_at FROM sessions WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .ok()?;
    if let Some(ended) = ended.filter(|at| at.is_finite() && *at >= 0.0) {
        if let Some(result) = terminal((ended * 1000.0) as u64, hook_ms, "reconciled_idle") {
            return Some(result);
        }
    }
    let (role, tools, reason, timestamp): (String, Option<String>, Option<String>, f64) = conn.query_row(
        "SELECT role, tool_calls, finish_reason, timestamp FROM messages WHERE session_id = ?1 AND active = 1 AND coalesce(observed, 0) = 0 AND coalesce(_compressed_summary, 0) = 0 ORDER BY id DESC LIMIT 1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional().ok()??;
    if role != "assistant"
        || tools
            .as_deref()
            .is_some_and(|value| !matches!(value, "" | "[]" | "null"))
        || !timestamp.is_finite()
        || timestamp < 0.0
    {
        return None;
    }
    let kind = match reason.as_deref()? {
        "stop" | "end_turn" | "length" | "max_tokens" => "reconciled_complete",
        "interrupted" | "cancelled" | "canceled" => "reconciled_interrupted",
        "error" | "agent_error" | "content_filter" => "reconciled_failed",
        _ => return None,
    };
    terminal((timestamp * 1000.0) as u64, hook_ms, kind)
}

fn local_url(value: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(value).ok()?;
    (value.len() <= 2048
        && url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|host| matches!(host, "127.0.0.1" | "[::1]" | "::1" | "localhost")))
    .then_some(url)
}

async fn get_json(client: &reqwest::Client, url: reqwest::Url, cwd: Option<&str>) -> Option<Value> {
    let mut request = client.get(url);
    if let Some(cwd) = cwd {
        request = request.query(&[("directory", cwd)]);
    }
    let mut response = request.send().await.ok()?.error_for_status().ok()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > 64 * 1024 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

async fn opencode_status(client: &reqwest::Client, event: &HookEventV1) -> Option<bool> {
    let base = local_url(event.status_url.as_deref()?)?;
    let mut session = base.join("/session/").ok()?;
    session.path_segments_mut().ok()?.pop_if_empty().push(&event.session_id);
    let info = get_json(client, session, event.cwd.as_deref()).await?;
    if info["id"].as_str() != Some(&event.session_id) {
        return None;
    }
    let statuses = get_json(
        client,
        base.join("/session/status").ok()?,
        event.cwd.as_deref(),
    )
    .await?;
    match statuses.as_object()?.get(&event.session_id) {
        Some(status) => match status["type"].as_str()? {
            "idle" => Some(true),
            "busy" | "retry" => Some(false),
            _ => None,
        },
        // OpenCode removes idle entries from its status map. Verify the exact
        // session exists above before interpreting an absent entry as idle.
        None => Some(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn claude_file(rows: &[Value]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        use std::io::Write;
        for row in rows {
            writeln!(file, "{row}").unwrap();
        }
        file
    }
    fn record(kind: &str, extra: Value) -> Value {
        let mut value =
            json!({"type": kind, "sessionId": "one", "timestamp": "2026-10-30T00:00:02Z"});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        value
    }

    #[test]
    fn claude_interruption_is_terminal_but_a_newer_prompt_or_tool_use_is_not() {
        let interrupted = record(
            "user",
            json!({"interruptedMessageId": "m", "message": {"content": [{"type": "text", "text": "[Request interrupted by user]"}]}}),
        );
        let housekeeping = record("system", json!({"subtype": "away_summary"}));
        let file = claude_file(&[interrupted.clone(), housekeeping]);
        let result = claude_terminal(file.path(), "one", 1).unwrap();
        assert_eq!(result.event, "reconciled_interrupted");
        assert!(claude_terminal(file.path(), "one", result.at_ms).is_none());
        for newer in [
            record("user", json!({"message": {"content": "new prompt"}})),
            record("assistant", json!({"message": {"stop_reason": "tool_use"}})),
            record("assistant", json!({"message": {"stop_reason": null}})),
        ] {
            let file = claude_file(&[interrupted.clone(), newer]);
            assert!(claude_terminal(file.path(), "one", 1).is_none());
        }
    }

    #[test]
    fn claude_reads_a_bounded_tail_and_ignores_sidechains_and_partial_records() {
        let done = record("assistant", json!({"message": {"stop_reason": "end_turn"}}));
        let child = record("user", json!({"isSidechain": true}));
        let file = claude_file(&[
            record(
                "assistant",
                json!({"message": {"content": "ท".repeat(100_000)}}),
            ),
            done,
            child,
        ]);
        assert_eq!(
            claude_terminal(file.path(), "one", 1).unwrap().event,
            "reconciled_complete"
        );
        use std::io::Write;
        let mut file = file;
        write!(file, "{{\"type\":\"user\"").unwrap();
        assert!(claude_terminal(file.path(), "one", 1).is_none());
    }

    #[test]
    fn opencode_latest_message_must_be_a_finished_assistant_response() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
        )
        .unwrap();
        let add = |id: &str, time: i64, data: Value| {
            conn.execute(
                "INSERT INTO message VALUES(?1, 'one', ?2, ?3)",
                rusqlite::params![id, time, data.to_string()],
            )
            .unwrap();
        };
        add(
            "1",
            1,
            json!({"role": "assistant", "finish": "stop", "time": {"completed": 2000}}),
        );
        assert_eq!(opencode_terminal(&conn, "one", 1000).unwrap().at_ms, 2000);
        assert!(opencode_terminal(&conn, "other", 1000).is_none());
        add("2", 2, json!({"role": "user"}));
        assert!(opencode_terminal(&conn, "one", 1000).is_none());
        add(
            "3",
            3,
            json!({"role": "assistant", "finish": "tool-calls", "time": {"completed": 4000}}),
        );
        assert!(opencode_terminal(&conn, "one", 1000).is_none());
        add(
            "4",
            4,
            json!({"role": "assistant", "error": {"name": "MessageAbortedError"}, "time": {"completed": 5000}}),
        );
        assert_eq!(
            opencode_terminal(&conn, "one", 1000).unwrap().event,
            "reconciled_interrupted"
        );
        assert!(opencode_terminal(&conn, "one", 5000).is_none());
    }

    fn hermes_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sessions(id TEXT, ended_at REAL); INSERT INTO sessions VALUES('one', NULL);
            CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, tool_calls TEXT, finish_reason TEXT, timestamp REAL, active INTEGER, observed INTEGER, _compressed_summary INTEGER);
            INSERT INTO messages VALUES(1, 'one', 'assistant', NULL, 'stop', 2.0, 1, 0, 0);
            CREATE TABLE session_admissions(target_session_id TEXT, status TEXT);
            CREATE TABLE worker_executions(session_id TEXT, status TEXT);
            CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);").unwrap();
        conn
    }

    #[test]
    fn hermes_terminal_evidence_respects_active_work_and_queued_admissions() {
        for blocker in [
            "INSERT INTO session_admissions VALUES('one', 'queued')",
            "INSERT INTO session_admissions VALUES('one', 'unknown')",
            "INSERT INTO worker_executions VALUES('one', 'running')",
            "INSERT INTO session_turn_leases VALUES('one', unixepoch()+60)",
        ] {
            let conn = hermes_db();
            conn.execute_batch(blocker).unwrap();
            assert!(hermes_terminal(&conn, "one", 1000).is_none(), "{blocker}");
        }
        let conn = hermes_db();
        assert_eq!(
            hermes_terminal(&conn, "one", 1000).unwrap().event,
            "reconciled_complete"
        );
    }

    #[test]
    fn hermes_does_not_infer_completion_from_silence_or_pending_tools() {
        for change in [
            "UPDATE messages SET role='user'",
            "UPDATE messages SET tool_calls='[{}]'",
            "UPDATE messages SET finish_reason=NULL",
            "UPDATE messages SET finish_reason='tool_calls'",
            "UPDATE messages SET timestamp=0.5",
        ] {
            let conn = hermes_db();
            conn.execute_batch(change).unwrap();
            assert!(hermes_terminal(&conn, "one", 1000).is_none(), "{change}");
        }
        let conn = hermes_db();
        conn.execute_batch("UPDATE messages SET finish_reason='interrupted'")
            .unwrap();
        assert_eq!(
            hermes_terminal(&conn, "one", 1000).unwrap().event,
            "reconciled_interrupted"
        );
    }

    #[test]
    fn provider_databases_are_read_only_and_remote_status_urls_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        assert!(open_db(&dir.path().join("missing.db")).is_none());
        let path = dir.path().join("state.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE sample(id INTEGER)")
            .unwrap();
        assert!(open_db(&path)
            .unwrap()
            .execute("INSERT INTO sample VALUES(1)", [])
            .is_err());
        for url in [
            "https://127.0.0.1:8080",
            "http://example.com",
            "file:///tmp/state",
            "http://user:password@127.0.0.1",
        ] {
            assert!(local_url(url).is_none());
        }
        assert!(local_url("http://127.0.0.1:8080").is_some());
    }

    #[tokio::test]
    async fn opencode_queries_the_exact_session_and_keeps_busy_sessions_working() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for status in ["busy", "retry", "idle", "absent"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let status = status.to_string();
            let expected = matches!(status.as_str(), "idle" | "absent");
            let server = tokio::spawn(async move {
                for step in 0..2 {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = vec![0; 4096];
                    let size = stream.read(&mut request).await.unwrap();
                    let request = std::str::from_utf8(&request[..size]).unwrap();
                    assert!(request.starts_with(if step == 0 {
                        "GET /session/one?"
                    } else {
                        "GET /session/status?"
                    }));
                    let body = if step == 0 {
                        json!({"id": "one"})
                    } else if status == "absent" {
                        json!({})
                    } else {
                        json!({"one": {"type": status}})
                    }
                    .to_string();
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
                }
            });
            let mut event = HookEventV1::from_provider_payload(
                ProcessProvider::Opencode,
                "user_prompt_submit",
                &json!({"session_id": "one", "cwd": "/project"}),
                Some("%1".into()),
                Some(1),
            )
            .unwrap();
            event.status_url = Some(format!("http://{address}"));
            assert_eq!(
                opencode_status(&reqwest::Client::new(), &event).await,
                Some(expected)
            );
            server.await.unwrap();
        }
    }
}
