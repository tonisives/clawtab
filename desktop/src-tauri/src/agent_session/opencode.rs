use super::common::{
    find_child_process, format_local_timestamp, normalize_optional_owned, normalize_optional_str,
    normalize_prompt_text,
};
use super::{ProcessSnapshot, SessionInfo};
use rusqlite::Connection;
use std::path::PathBuf;

#[derive(Clone)]
struct OpencodeSessionInfo {
    id: String,
    title: String,
    time_created: i64,
}

pub(super) fn resolve_session_info(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
    cwd: Option<&str>,
) -> SessionInfo {
    let mut info = SessionInfo::default();
    let Some(cwd) = cwd.and_then(normalize_optional_str) else {
        return info;
    };

    let prompt = find_opencode_prompt(pane_pid, snapshot);
    let Some(session) = find_opencode_session(&cwd, prompt.as_deref()) else {
        return info;
    };

    let started_secs = session.time_created / 1000;
    info.started_epoch = Some(started_secs as u64);
    info.session_started_at = format_local_timestamp(started_secs);

    let (first, last) = read_opencode_user_messages(&session.id);
    info.first_query = prompt
        .clone()
        .or(first)
        .or_else(|| normalize_optional_owned(session.title.clone()));
    info.last_query = last;

    if info
        .first_query
        .as_deref()
        .is_some_and(|title| title.starts_with("New session - "))
    {
        info.first_query = None;
    }

    if info.last_query.is_none() {
        info.last_query = info.first_query.clone();
    } else if info.first_query == info.last_query {
        info.last_query = None;
    }

    info
}

fn opencode_db_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".local/share/opencode/opencode.db")
}

fn find_opencode_session(cwd: &str, prompt: Option<&str>) -> Option<OpencodeSessionInfo> {
    let conn = Connection::open(opencode_db_path()).ok()?;
    let mut stmt = conn
        .prepare(
            "select id, title, time_created
             from session
             where ?1 = directory or ?1 like directory || '/%'
             order by length(directory) desc, time_updated desc, time_created desc
             limit 12",
        )
        .ok()?;

    let candidates = stmt
        .query_map([cwd], |row| {
            Ok(OpencodeSessionInfo {
                id: row.get(0)?,
                title: row.get(1)?,
                time_created: row.get(2)?,
            })
        })
        .ok()?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return None;
    }

    let normalized_prompt = prompt.and_then(normalize_prompt_text);
    if let Some(ref prompt_text) = normalized_prompt {
        for candidate in &candidates {
            let (first, _) = read_opencode_user_messages(&candidate.id);
            if first.as_deref().and_then(normalize_prompt_text).as_deref()
                == Some(prompt_text.as_str())
            {
                return Some(candidate.clone());
            }
        }

        for candidate in &candidates {
            if normalize_optional_str(&candidate.title)
                .and_then(|title| normalize_prompt_text(&title))
                .as_deref()
                == Some(prompt_text.as_str())
            {
                return Some(candidate.clone());
            }
        }
    }

    candidates.into_iter().next()
}

fn read_opencode_user_messages(session_id: &str) -> (Option<String>, Option<String>) {
    let conn = match Connection::open(opencode_db_path()) {
        Ok(conn) => conn,
        Err(_) => return (None, None),
    };
    let mut stmt = match conn.prepare(
        "select p.data
         from part p
         join message m on m.id = p.message_id
         where p.session_id = ?1
           and json_extract(m.data, '$.role') = 'user'
           and json_extract(p.data, '$.type') = 'text'
         order by p.time_created asc, p.id asc",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return (None, None),
    };

    let rows = match stmt.query_map([session_id], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows,
        Err(_) => return (None, None),
    };

    let mut first = None;
    let mut last = None;

    for row in rows {
        let Ok(data) = row else {
            continue;
        };
        let text = serde_json::from_str::<serde_json::Value>(&data)
            .ok()
            .and_then(|value| {
                value
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .and_then(normalize_optional_owned);

        if first.is_none() {
            first = text.clone();
        }
        if text.is_some() {
            last = text;
        }
    }

    if first.is_some() && first == last {
        (first, None)
    } else {
        (first, last)
    }
}

fn find_opencode_child(parent_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<String> {
    find_child_process(parent_pid, snapshot, is_opencode_command)
}

fn is_opencode_process_with_snapshot(pid: &str, snapshot: Option<&ProcessSnapshot>) -> bool {
    match snapshot.and_then(|snap| snap.command_for_pid(pid)) {
        Some(command) => is_opencode_command(command),
        None => false,
    }
}

fn is_opencode_command(command: &str) -> bool {
    command.to_ascii_lowercase().contains("opencode")
}

fn find_opencode_prompt(pane_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<String> {
    let owned_snapshot;
    let snapshot = match snapshot {
        Some(snapshot) => snapshot,
        None => {
            owned_snapshot = ProcessSnapshot::capture();
            &owned_snapshot
        }
    };

    let opencode_pid = if is_opencode_process_with_snapshot(pane_pid, Some(snapshot)) {
        Some(pane_pid.to_string())
    } else {
        find_opencode_child(pane_pid, Some(snapshot))
    }?;

    snapshot
        .command_for_pid(&opencode_pid)
        .and_then(parse_opencode_prompt_from_command)
}

fn parse_opencode_prompt_from_command(command: &str) -> Option<String> {
    let marker = "--prompt ";
    let start = command.find(marker)?;
    let raw = &command[start + marker.len()..];
    normalize_prompt_text(raw)
}
