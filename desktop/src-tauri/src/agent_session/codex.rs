use super::common::{
    find_child_process, format_local_timestamp, normalize_optional_owned, normalize_optional_str,
};
use super::{ProcessSnapshot, SessionInfo};
use rusqlite::{Connection, OptionalExtension};
use std::fs;
use std::io::BufRead;
use std::path::PathBuf;

struct CodexThreadInfo {
    id: String,
    created_at: i64,
    first_user_message: String,
    rollout_path: Option<String>,
}

pub(super) fn resolve_session_info(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    let mut info = SessionInfo::default();

    let codex_pid = if is_codex_process_with_snapshot(pane_pid, snapshot) {
        pane_pid.to_string()
    } else {
        match find_codex_child(pane_pid, snapshot) {
            Some(pid) => pid,
            None => return info,
        }
    };

    let Some(thread_id) = find_codex_thread_id_by_pid(&codex_pid) else {
        return info;
    };

    let Some(thread) = read_codex_thread(&thread_id) else {
        return info;
    };

    info.first_query = normalize_optional_owned(thread.first_user_message);
    info.last_query = read_codex_last_query(&thread.id);

    let started_secs = thread.created_at / 1000;
    info.started_epoch = Some(started_secs as u64);
    info.session_started_at = format_local_timestamp(started_secs);

    if info.first_query.is_none() || info.last_query.is_none() {
        if let Some(rollout_path) = thread.rollout_path {
            let rollout = PathBuf::from(rollout_path);
            let (first, last) = read_codex_rollout_messages(&rollout);
            if info.first_query.is_none() {
                info.first_query = first;
            }
            if info.last_query.is_none() {
                info.last_query = last;
            }
        }
    }

    if info.last_query.is_none() {
        info.last_query = info.first_query.clone();
    } else if info.first_query == info.last_query {
        info.last_query = None;
    }

    info
}

fn find_codex_child(parent_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<String> {
    find_child_process(parent_pid, snapshot, is_codex_command)
}

fn is_codex_process_with_snapshot(pid: &str, snapshot: Option<&ProcessSnapshot>) -> bool {
    match snapshot.and_then(|snap| snap.command_for_pid(pid)) {
        Some(command) => is_codex_command(command),
        None => false,
    }
}

fn is_codex_command(command: &str) -> bool {
    command.to_ascii_lowercase().contains("codex")
}

fn codex_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".codex")
}

fn latest_codex_sqlite(prefix: &str) -> Option<PathBuf> {
    let dir = codex_dir();
    let entries = fs::read_dir(dir).ok()?;
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with(prefix) && name.ends_with(".sqlite"))
                .unwrap_or(false)
        })
        .filter_map(|path| {
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn find_codex_thread_id_by_pid(pid: &str) -> Option<String> {
    let db_path = latest_codex_sqlite("logs_")?;
    let conn = Connection::open(db_path).ok()?;
    conn.query_row(
        "select thread_id from logs
         where process_uuid like ?1 and thread_id is not null
         order by ts desc, ts_nanos desc, id desc
         limit 1",
        [format!("pid:{}:%", pid)],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn read_codex_thread(thread_id: &str) -> Option<CodexThreadInfo> {
    let db_path = latest_codex_sqlite("state_")?;
    let conn = Connection::open(db_path).ok()?;
    conn.query_row(
        "select id, created_at, first_user_message, rollout_path
         from threads where id = ?1 limit 1",
        [thread_id],
        |row| {
            Ok(CodexThreadInfo {
                id: row.get(0)?,
                created_at: row.get(1)?,
                first_user_message: row.get(2)?,
                rollout_path: row.get(3).ok(),
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

fn read_codex_last_query(thread_id: &str) -> Option<String> {
    let path = codex_dir().join("history.jsonl");
    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut last = None;

    for line in reader.lines() {
        let line = line.ok()?;
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        if value.get("session_id")?.as_str()? != thread_id {
            continue;
        }
        last = value
            .get("text")
            .and_then(|v| v.as_str())
            .and_then(normalize_optional_str);
    }

    last
}

fn read_codex_rollout_messages(path: &PathBuf) -> (Option<String>, Option<String>) {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return (None, None),
    };
    let reader = std::io::BufReader::new(file);
    let mut first = None;
    let mut last = None;

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let text = value
            .get("payload")
            .and_then(|payload| payload.get("message"))
            .and_then(|message| message.as_str())
            .or_else(|| {
                value
                    .get("payload")
                    .and_then(|payload| payload.get("content"))
                    .and_then(|content| content.as_array())
                    .and_then(|items| {
                        items.iter().find_map(|item| {
                            if item.get("type")?.as_str()? == "input_text" {
                                item.get("text")?.as_str()
                            } else {
                                None
                            }
                        })
                    })
            })
            .and_then(normalize_optional_str);

        if value.get("type").and_then(|v| v.as_str()) == Some("event_msg")
            && value
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(|v| v.as_str())
                == Some("user_message")
        {
            if first.is_none() {
                first = text.clone();
            }
            if text.is_some() {
                last = text;
            }
        } else if value.get("type").and_then(|v| v.as_str()) == Some("response_item")
            && value
                .get("payload")
                .and_then(|payload| payload.get("role"))
                .and_then(|v| v.as_str())
                == Some("user")
        {
            if first.is_none() {
                first = text.clone();
            }
            if text.is_some() {
                last = text;
            }
        }
    }

    if first.is_some() && first == last {
        (first, None)
    } else {
        (first, last)
    }
}
