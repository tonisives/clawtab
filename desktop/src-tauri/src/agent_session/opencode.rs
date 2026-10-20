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

    let owned_snapshot;
    let snapshot = match snapshot {
        Some(s) => s,
        None => {
            owned_snapshot = ProcessSnapshot::capture();
            &owned_snapshot
        }
    };

    let opencode_pid = resolve_opencode_pid(pane_pid, snapshot);
    let process_start_epoch = opencode_pid
        .as_deref()
        .and_then(|pid| snapshot.start_epoch_for_pid(pid));

    let prompt = opencode_pid
        .as_deref()
        .and_then(|pid| snapshot.command_for_pid(pid))
        .and_then(parse_opencode_prompt_from_command);

    let session_id = opencode_pid
        .as_deref()
        .and_then(|pid| snapshot.command_for_pid(pid))
        .and_then(parse_opencode_session_from_command);

    let Some(session) =
        find_opencode_session(&cwd, session_id, prompt.as_deref(), process_start_epoch)
    else {
        return info;
    };

    info.session_id = Some(session.id.clone());
    info.title = normalize_optional_str(&session.title).filter(|title| {
        !title.starts_with("New session - ") && !title.starts_with("Child session - ")
    });

    let started_secs = session.time_created / 1000;
    info.started_epoch = Some(started_secs as u64);
    info.session_started_at = format_local_timestamp(started_secs);

    let (first, last) = read_opencode_user_messages(&session.id);
    info.first_query = prompt
        .clone()
        .or(first)
        .or_else(|| normalize_optional_owned(session.title.clone()));
    info.last_query = last;
    info.last_user_message_at = Connection::open(opencode_db_path()).ok().and_then(|conn| {
        conn.query_row(
            "select max(time_created) from message where session_id = ?1 and json_extract(data, '$.role') = 'user'",
            [&session.id], |row| row.get(0),
        ).ok().flatten()
    });
    info.token_count = read_opencode_token_count(&session.id);

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

/// Find the opencode session belonging to a running process.
///
/// Prompt-match path (explicit `--prompt` arg) wins unconditionally — the command-line
/// prompt is a strong enough signal to trust.
///
/// Fallback path requires a `process_start_epoch`: we only return a candidate whose
/// `session.time_created` is on-or-after the process's own start time (with a small
/// slack). This prevents a fresh interactive opencode from inheriting a sibling pane's
/// session in the same cwd. If no start epoch is known, we refuse to guess and return
/// `None` — an empty display is better than a wrong one.
fn find_opencode_session(
    cwd: &str,
    session_id: Option<&str>,
    prompt: Option<&str>,
    process_start_epoch: Option<i64>,
) -> Option<OpencodeSessionInfo> {
    let conn = Connection::open(opencode_db_path()).ok()?;
    if let Some(id) = session_id {
        return read_opencode_session_by_id(&conn, id);
    }
    let mut stmt = conn
        .prepare(
            "select id, title, time_created
             from session
             where ?1 = directory or ?1 like directory || '/%'
             order by length(directory) desc, time_created desc, time_updated desc
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

    // Fallback: only accept a session created at or after this process started.
    // 2 second slack absorbs fork-to-insert latency and small clock drift.
    session_by_start(candidates, process_start_epoch)
}

fn read_opencode_session_by_id(conn: &Connection, id: &str) -> Option<OpencodeSessionInfo> {
    conn.query_row(
        "select id, title, time_created from session where id = ?1",
        [id],
        |row| {
            Ok(OpencodeSessionInfo {
                id: row.get(0)?,
                title: row.get(1)?,
                time_created: row.get(2)?,
            })
        },
    )
    .ok()
}

fn session_by_start(
    candidates: Vec<OpencodeSessionInfo>,
    process_start_epoch: Option<i64>,
) -> Option<OpencodeSessionInfo> {
    let proc_start = process_start_epoch?;
    let cutoff_ms = (proc_start - 2) * 1000;
    let mut matching = candidates
        .into_iter()
        .filter(|c| c.time_created >= cutoff_ms);
    let session = matching.next()?;
    // Several interactive panes can create sessions in the same directory.
    // Never label one pane with another pane's most recent conversation.
    matching.next().is_none().then_some(session)
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

fn read_opencode_token_count(session_id: &str) -> Option<u64> {
    let conn = Connection::open(opencode_db_path()).ok()?;
    let mut stmt = conn
        .prepare(
            "select data
             from message
             where session_id = ?1
               and json_extract(data, '$.role') = 'assistant'
             order by time_created desc, id desc
             limit 20",
        )
        .ok()?;

    let rows = stmt
        .query_map([session_id], |row| row.get::<_, String>(0))
        .ok()?;

    for row in rows {
        let Ok(data) = row else {
            continue;
        };
        let Some(count) = serde_json::from_str::<serde_json::Value>(&data)
            .ok()
            .and_then(|value| {
                value
                    .get("tokens")
                    .and_then(|tokens| tokens.get("total"))
                    .and_then(|v| v.as_u64())
            })
        else {
            continue;
        };
        return Some(count);
    }

    None
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

fn resolve_opencode_pid(pane_pid: &str, snapshot: &ProcessSnapshot) -> Option<String> {
    if is_opencode_process_with_snapshot(pane_pid, Some(snapshot)) {
        Some(pane_pid.to_string())
    } else {
        find_opencode_child(pane_pid, Some(snapshot))
    }
}

fn parse_opencode_prompt_from_command(command: &str) -> Option<String> {
    let marker = "--prompt ";
    let start = command.find(marker)?;
    let raw = &command[start + marker.len()..];
    normalize_prompt_text(raw)
}

fn parse_opencode_session_from_command(command: &str) -> Option<&str> {
    let mut args = command.split_whitespace();
    while let Some(arg) = args.next() {
        if let Some(id) = arg.strip_prefix("--session=") {
            return (!id.is_empty()).then_some(id);
        }
        if arg == "--session" || arg == "-s" {
            return args.next();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumed_sessions_have_an_explicit_identity() {
        for command in [
            "opencode --session ses_123",
            "opencode -s ses_123",
            "opencode --session=ses_123",
        ] {
            assert_eq!(
                parse_opencode_session_from_command(command),
                Some("ses_123")
            );
        }
        assert_eq!(
            parse_opencode_session_from_command("opencode --continue"),
            None
        );
    }

    #[test]
    fn sibling_sessions_are_not_assigned_the_same_title() {
        let session = |time_created| OpencodeSessionInfo {
            id: format!("session-{time_created}"),
            title: "Generated title".to_string(),
            time_created,
        };
        assert!(session_by_start(vec![session(100_000)], None).is_none());
        assert!(session_by_start(vec![session(50_000)], Some(100)).is_none());
        assert_eq!(
            session_by_start(vec![session(100_000)], Some(100))
                .expect("one session")
                .id,
            "session-100000"
        );
        assert!(session_by_start(vec![session(100_000), session(110_000)], Some(100)).is_none());
    }
}
