use super::common::{
    find_child_process, format_local_timestamp, insert_bounded, normalize_optional_owned,
    normalize_optional_str, normalize_unix_timestamp_secs, SESSION_CACHE_MAX_ENTRIES,
};
use super::{ProcessSnapshot, SessionActivity, SessionInfo};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::HashMap;
use std::fs;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};

struct CodexThreadInfo {
    id: String,
    name: Option<String>,
    created_at: i64,
    first_user_message: String,
    rollout_path: Option<String>,
}

#[derive(Clone)]
struct CachedHistory {
    modified: Option<SystemTime>,
    len: u64,
    last_by_thread_id: HashMap<String, Option<String>>,
}

#[derive(Clone)]
struct CachedRollout {
    modified: Option<SystemTime>,
    len: u64,
    messages_loaded: bool,
    first: Option<String>,
    last: Option<String>,
    token_count: Option<u64>,
    model_id: Option<String>,
    agent_effort: Option<String>,
}

#[derive(Clone)]
struct CachedSqlitePath {
    checked_at: Instant,
    path: Option<PathBuf>,
}

#[derive(Clone)]
struct CachedThreadId {
    checked_at: Instant,
    process_start_epoch: Option<i64>,
    thread_id: Option<String>,
}

fn history_cache() -> &'static Mutex<HashMap<PathBuf, CachedHistory>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedHistory>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sqlite_path_cache() -> &'static Mutex<HashMap<String, CachedSqlitePath>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSqlitePath>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn rollout_cache() -> &'static Mutex<HashMap<PathBuf, CachedRollout>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedRollout>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn thread_id_cache() -> &'static Mutex<HashMap<String, CachedThreadId>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedThreadId>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn resolve_session_info(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    resolve_session_info_with_details(pane_pid, snapshot, true)
}

pub(super) fn resolve_session_info_fast(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    resolve_session_info_with_details(pane_pid, snapshot, false)
}

fn resolve_session_info_with_details(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
    include_details: bool,
) -> SessionInfo {
    let mut info = SessionInfo {
        title: session_from_pane_title(pane_pid).map(|session| session.name),
        ..SessionInfo::default()
    };

    let Some(thread_id) = thread_id_for_pane(pane_pid, snapshot) else {
        return info;
    };

    let Some(thread) = read_codex_thread(&thread_id) else {
        return info;
    };

    info.session_id = Some(thread.id.clone());
    info.title = info
        .title
        .or_else(|| thread.name.and_then(normalize_optional_owned));
    info.first_query = normalize_optional_owned(thread.first_user_message);
    info.last_query = read_codex_last_query(&thread.id);

    let started_secs = normalize_unix_timestamp_secs(thread.created_at);
    info.started_epoch = Some(started_secs as u64);
    info.session_started_at = format_local_timestamp(started_secs);

    if let Some(rollout_path) = thread.rollout_path.as_deref() {
        info.session_file_size_bytes = session_file_size(std::path::Path::new(rollout_path));
        info.last_user_message_at = read_last_user_message_at(std::path::Path::new(rollout_path));
        let needs_messages = info.first_query.is_none() || info.last_query.is_none();
        if include_details || needs_messages {
            let rollout = read_codex_rollout(&PathBuf::from(rollout_path), needs_messages);
            if include_details {
                info.token_count = rollout.token_count;
                info.model_id = rollout.model_id;
                info.agent_effort = rollout.agent_effort;
            }
            if info.first_query.is_none() {
                info.first_query = rollout.first;
            }
            if info.last_query.is_none() {
                info.last_query = rollout.last;
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

pub(crate) fn session_activity_for_pane(
    pane_pid: &str,
    snapshot: &ProcessSnapshot,
) -> Option<SessionActivity> {
    let thread_id = thread_id_for_pane(pane_pid, Some(snapshot))?;
    let thread = read_codex_thread(&thread_id)?;
    let path = PathBuf::from(thread.rollout_path?);
    Some(SessionActivity {
        last_action_at_ms: read_last_action_at(&path).and_then(|time| u64::try_from(time).ok()),
        file_size_bytes: session_file_size(&path),
    })
}

fn session_file_size(path: &std::path::Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
}

pub(crate) fn thread_id_for_pane(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> Option<String> {
    let codex_pid = if is_codex_process_with_snapshot(pane_pid, snapshot) {
        pane_pid.to_string()
    } else {
        find_codex_child(pane_pid, snapshot)?
    };

    let process_start_epoch =
        snapshot.and_then(|snapshot| snapshot.start_epoch_for_pid(&codex_pid));
    // Daemon-backed TUIs have no thread IDs in their process logs. Match the
    // displayed session only when both its exact name and directory are unique.
    // Check this first: a shared server can itself descend from another TUI.
    thread_id_from_pane_title(pane_pid)
        .or_else(|| cached_codex_thread_id_by_pid(&codex_pid, process_start_epoch))
}

#[derive(Default)]
struct PaneTitleCache {
    checked_at: Option<Instant>,
    sessions: HashMap<String, PaneTitleSession>,
}

#[derive(Clone)]
struct PaneTitleSession {
    name: String,
    thread_id: Option<String>,
}

fn thread_id_from_pane_title(pane_pid: &str) -> Option<String> {
    session_from_pane_title(pane_pid)?.thread_id
}

fn session_from_pane_title(pane_pid: &str) -> Option<PaneTitleSession> {
    static CACHE: OnceLock<Mutex<PaneTitleCache>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock();
    if cache
        .checked_at
        .is_none_or(|time| time.elapsed() >= Duration::from_secs(2))
    {
        cache.sessions = read_pane_title_sessions().unwrap_or_default();
        cache.checked_at = Some(Instant::now());
    }
    cache.sessions.get(pane_pid).cloned()
}

fn read_pane_title_sessions() -> Option<HashMap<String, PaneTitleSession>> {
    let conn = Connection::open_with_flags(
        latest_codex_sqlite("state_")?,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()?;
    let mut sessions = HashMap::new();
    let output = std::process::Command::new("tmux")
        .args([
            "list-panes",
            "-a",
            "-F",
            "#{pane_pid}\t#{pane_current_path}\t#{pane_title}",
        ])
        .output()
        .ok();
    let output = output.filter(|output| output.status.success());
    let stdout = output.map(|output| output.stdout).unwrap_or_default();
    for line in String::from_utf8_lossy(&stdout).lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(pid), Some(cwd), Some(title)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if let Some(session) = session_for_title(&conn, title, cwd) {
            sessions.insert(pid.to_string(), session);
        }
    }
    for info in crate::managed::list().unwrap_or_default() {
        let Some(title) = info.launch.metadata.get("title") else {
            continue;
        };
        if let Some(session) = session_for_title(&conn, title, &info.launch.cwd) {
            sessions.insert(info.child_pid.to_string(), session);
        }
    }
    Some(sessions)
}

fn session_for_title(conn: &Connection, title: &str, cwd: &str) -> Option<PaneTitleSession> {
    let (name, _) = title.rsplit_once(" | ")?;
    // The TUI replaces its spinner with either phase of a blinking marker
    // while a permission prompt is waiting for an answer.
    let name = name
        .strip_prefix("[ . ] Action Required | ")
        .or_else(|| name.strip_prefix("[ ! ] Action Required | "))
        .unwrap_or(name);
    // Codex prefixes an active task with a Braille spinner, but idle titles
    // start directly with the session name. Preserve non-ASCII user text.
    let name = match name.chars().next() {
        Some(first) if ('\u{2800}'..='\u{28ff}').contains(&first) => {
            name.get(first.len_utf8()..)?.trim_start()
        }
        _ => name,
    };
    if name.is_empty() {
        return None;
    }
    let mut query = conn
        .prepare("select id from threads where name = ?1 and cwd = ?2 and archived = 0 limit 2")
        .ok()?;
    let mut rows = query.query(params![name, cwd]).ok()?;
    let id: String = rows.next().ok()??.get(0).ok()?;
    // Duplicate names still identify the visible label, but do not identify
    // a conversation. Never expose another session's prompts or history.
    let thread_id = rows.next().ok()?.is_none().then_some(id);
    Some(PaneTitleSession {
        name: name.to_string(),
        thread_id,
    })
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
    const SQLITE_PATH_CACHE_TTL: Duration = Duration::from_secs(2);
    {
        let cache = sqlite_path_cache().lock();
        if let Some(cached) = cache.get(prefix) {
            if cached.checked_at.elapsed() < SQLITE_PATH_CACHE_TTL {
                return cached.path.clone();
            }
        }
    }

    let dir = codex_dir();
    let entries = fs::read_dir(dir).ok()?;
    let path = entries
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
        .map(|(_, path)| path);

    {
        let mut cache = sqlite_path_cache().lock();
        insert_bounded(
            &mut cache,
            prefix.to_string(),
            CachedSqlitePath {
                checked_at: Instant::now(),
                path: path.clone(),
            },
            SESSION_CACHE_MAX_ENTRIES,
        );
    }
    path
}

fn find_codex_thread_id_by_pid(pid: &str, process_start_epoch: Option<i64>) -> Option<String> {
    let db_path = latest_codex_sqlite("logs_")?;
    let conn = Connection::open(db_path).ok()?;
    let process_uuid = format!("pid:{}:%", pid);
    match process_start_epoch {
        Some(start_epoch) => conn
            .query_row(
                "select thread_id from logs
                 where process_uuid like ?1 and thread_id is not null and ts >= ?2
                 order by ts desc, ts_nanos desc, id desc
                 limit 1",
                params![process_uuid, start_epoch],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten(),
        None => conn
            .query_row(
                "select thread_id from logs
                 where process_uuid like ?1 and thread_id is not null
                 order by ts desc, ts_nanos desc, id desc
                 limit 1",
                [process_uuid],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten(),
    }
}

fn cached_codex_thread_id_by_pid(pid: &str, process_start_epoch: Option<i64>) -> Option<String> {
    const THREAD_ID_HIT_CACHE_TTL: Duration = Duration::from_secs(300);
    const THREAD_ID_MISS_CACHE_TTL: Duration = Duration::from_secs(2);

    let mut cache = thread_id_cache().lock();
    if let Some(cached) = cache.get(pid) {
        let ttl = if cached.thread_id.is_some() {
            THREAD_ID_HIT_CACHE_TTL
        } else {
            THREAD_ID_MISS_CACHE_TTL
        };
        if cached.process_start_epoch == process_start_epoch && cached.checked_at.elapsed() < ttl {
            return cached.thread_id.clone();
        }
    }

    let thread_id = find_codex_thread_id_by_pid(pid, process_start_epoch);
    insert_bounded(
        &mut cache,
        pid.to_string(),
        CachedThreadId {
            checked_at: Instant::now(),
            process_start_epoch,
            thread_id: thread_id.clone(),
        },
        SESSION_CACHE_MAX_ENTRIES,
    );
    thread_id
}

fn read_codex_thread(thread_id: &str) -> Option<CodexThreadInfo> {
    let db_path = latest_codex_sqlite("state_")?;
    let conn = Connection::open(db_path).ok()?;
    read_codex_thread_from_db(&conn, thread_id)
}

fn read_codex_thread_from_db(conn: &Connection, thread_id: &str) -> Option<CodexThreadInfo> {
    // `name` is the generated label shown in Codex's agents list. Older
    // schemas only have `title`, which can be the entire initial prompt.
    let name_column = if conn.prepare("select name from threads limit 0").is_ok() {
        "name"
    } else {
        "null"
    };
    conn.query_row(
        &format!(
            "select id, created_at, first_user_message, rollout_path, {name_column}
         from threads where id = ?1 limit 1"
        ),
        [thread_id],
        |row| {
            Ok(CodexThreadInfo {
                id: row.get(0)?,
                name: row.get(4).ok().flatten(),
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

fn read_last_user_message_at(path: &std::path::Path) -> Option<i64> {
    super::common::last_user_message_at(path, |value| {
        value.get("type").and_then(|value| value.as_str()) == Some("event_msg")
            && value
                .pointer("/payload/type")
                .and_then(|value| value.as_str())
                == Some("user_message")
    })
}

fn read_last_action_at(path: &std::path::Path) -> Option<i64> {
    super::common::last_action_at(path, |value| {
        match value.get("type").and_then(|value| value.as_str()) {
            Some("response_item") => {
                // Resuming a session can replay user, system, and developer context.
                // Prompt events identify new user messages separately.
                value
                    .pointer("/payload/type")
                    .and_then(|value| value.as_str())
                    != Some("message")
                    || value
                        .pointer("/payload/role")
                        .and_then(|value| value.as_str())
                        == Some("assistant")
            }
            Some("event_msg") => match value
                .pointer("/payload/type")
                .and_then(|value| value.as_str())
            {
                Some("user_message" | "agent_message" | "agent_reasoning" | "turn_aborted") => true,
                Some("item_completed") => value
                    .pointer("/payload/item/type")
                    .and_then(|value| value.as_str())
                    .is_some_and(|kind| kind != "ContextCompaction"),
                Some("task_complete") => value
                    .pointer("/payload/last_agent_message")
                    .and_then(|value| value.as_str())
                    .is_some_and(|message| !message.trim().is_empty()),
                _ => false,
            },
            _ => false,
        }
    })
}

fn read_codex_last_query(thread_id: &str) -> Option<String> {
    let path = codex_dir().join("history.jsonl");
    let metadata = fs::metadata(&path).ok()?;
    let modified = metadata.modified().ok();
    let len = metadata.len();

    {
        let cache = history_cache().lock();
        if let Some(cached) = cache.get(&path) {
            if cached.len == len && cached.modified == modified {
                return cached.last_by_thread_id.get(thread_id).cloned().flatten();
            }
        }
    }

    if let Some(result) = read_codex_last_query_from_tail(&path, thread_id, len) {
        return result;
    }

    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut last_by_thread_id: HashMap<String, Option<String>> = HashMap::new();

    for line in reader.lines() {
        let Ok(line) = line else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(session_id) = value.get("session_id").and_then(|v| v.as_str()) else {
            continue;
        };
        let text = value
            .get("text")
            .and_then(|v| v.as_str())
            .and_then(normalize_optional_str);
        insert_bounded(
            &mut last_by_thread_id,
            session_id.to_string(),
            text,
            SESSION_CACHE_MAX_ENTRIES,
        );
    }

    let result = last_by_thread_id.get(thread_id).cloned().flatten();
    {
        let mut cache = history_cache().lock();
        insert_bounded(
            &mut cache,
            codex_dir().join("history.jsonl"),
            CachedHistory {
                modified,
                len,
                last_by_thread_id,
            },
            SESSION_CACHE_MAX_ENTRIES,
        );
    }
    result
}

/// Interrupting Codex can end a turn without emitting a Stop hook.
/// Consult the recorded lifecycle, never inactivity, to repair that hook state.
pub(crate) fn completed_turn_after(thread_id: &str, hook_timestamp_ms: u64) -> Option<u64> {
    let thread = read_codex_thread(thread_id)?;
    let path = PathBuf::from(thread.rollout_path?);
    read_completed_turn_after(&path, hook_timestamp_ms)
}

fn read_completed_turn_after(path: &std::path::Path, hook_timestamp_ms: u64) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};

    // Bound polling work even for long sessions. Missing or truncated evidence
    // leaves the hook authoritative until a subsequent poll can resolve it.
    const MAX_TAIL_BYTES: u64 = 64 * 1024;
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(MAX_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let text = if start > 0 {
        text.split_once('\n')?.1
    } else {
        &text
    };
    // A partial record could be a newer turn start; wait for it to finish.
    if !text.ends_with('\n') {
        return None;
    }
    let (complete_lines, _) = text.rsplit_once('\n')?;
    for line in complete_lines.lines().rev() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|value| value.as_str()) != Some("event_msg") {
            continue;
        }
        match value
            .pointer("/payload/type")
            .and_then(|value| value.as_str())
        {
            Some("task_started") => return None,
            Some("task_complete" | "turn_aborted") => {
                let timestamp =
                    chrono::DateTime::parse_from_rfc3339(value.get("timestamp")?.as_str()?)
                        .ok()?
                        .timestamp_millis();
                let timestamp = u64::try_from(timestamp).ok()?;
                return (timestamp > hook_timestamp_ms).then_some(timestamp);
            }
            _ => {}
        }
    }
    None
}

/// History is append-only, so the current session's latest prompt is usually
/// in the tail. Avoid scanning every historical session on each short-lived
/// `cwtctl agent info` process; retain the full-file fallback for old or
/// interleaved sessions whose latest entry is outside the tail window.
fn read_codex_last_query_from_tail(
    path: &PathBuf,
    thread_id: &str,
    len: u64,
) -> Option<Option<String>> {
    use std::io::{Read, Seek, SeekFrom};

    const MAX_HISTORY_TAIL_BYTES: u64 = 512 * 1024;
    let start = len.saturating_sub(MAX_HISTORY_TAIL_BYTES);
    let mut file = fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;

    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    if start > 0 {
        let newline = bytes.iter().position(|byte| *byte == b'\n')?;
        bytes.drain(..=newline);
    }

    let text = String::from_utf8_lossy(&bytes);
    for line in text.lines().rev() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(session_id) = value.get("session_id").and_then(|value| value.as_str()) else {
            continue;
        };
        if session_id != thread_id {
            continue;
        }
        return Some(
            value
                .get("text")
                .and_then(|value| value.as_str())
                .and_then(normalize_optional_str),
        );
    }
    None
}

fn read_codex_rollout(path: &PathBuf, include_messages: bool) -> CachedRollout {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return CachedRollout {
                modified: None,
                len: 0,
                messages_loaded: include_messages,
                first: None,
                last: None,
                token_count: None,
                model_id: None,
                agent_effort: None,
            }
        }
    };
    let modified = metadata.modified().ok();
    let len = metadata.len();
    let existing = {
        let cache = rollout_cache().lock();
        cache
            .get(path)
            .filter(|cached| cached.len == len && cached.modified == modified)
            .cloned()
    };

    if let Some(cached) = existing.as_ref() {
        if cached.messages_loaded || !include_messages {
            return cached.clone();
        }
    }

    let token_count = if let Some(cached) = existing.as_ref() {
        cached.token_count
    } else {
        read_codex_rollout_token_count(path)
    };
    let (model_id, agent_effort) = if let Some(cached) = existing.as_ref() {
        (cached.model_id.clone(), cached.agent_effort.clone())
    } else {
        read_codex_rollout_selection(path)
    };

    let (first, last) = if include_messages {
        read_codex_rollout_messages(path)
    } else if let Some(cached) = existing.as_ref() {
        (cached.first.clone(), cached.last.clone())
    } else {
        (None, None)
    };

    let messages_loaded = include_messages
        || existing
            .as_ref()
            .is_some_and(|cached| cached.messages_loaded);
    let cached = CachedRollout {
        modified,
        len,
        messages_loaded,
        first,
        last,
        token_count,
        model_id,
        agent_effort,
    };
    {
        let mut cache = rollout_cache().lock();
        insert_bounded(
            &mut cache,
            path.clone(),
            cached.clone(),
            SESSION_CACHE_MAX_ENTRIES,
        );
    }
    cached
}

fn read_codex_rollout_selection(path: &PathBuf) -> (Option<String>, Option<String>) {
    super::common::read_latest_jsonl(path, |value| {
        if value.get("type")?.as_str()? != "turn_context" {
            return None;
        }
        let payload = value.get("payload")?;
        let model = payload
            .get("model")?
            .as_str()
            .and_then(normalize_optional_str)?;
        let effort = payload
            .get("effort")
            .and_then(|value| value.as_str())
            .and_then(normalize_optional_str);
        Some((Some(model), effort))
    })
    .unwrap_or((None, None))
}

fn read_codex_rollout_token_count(path: &PathBuf) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return None;
    }

    let mut pos = len;
    let mut buf = Vec::new();
    const CHUNK_SIZE: u64 = 8192;
    const MAX_TAIL_BYTES: usize = 512 * 1024;

    while pos > 0 && buf.len() < MAX_TAIL_BYTES {
        let start = pos.saturating_sub(CHUNK_SIZE);
        let chunk_len = (pos - start) as usize;
        let mut chunk = vec![0u8; chunk_len];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut chunk).ok()?;
        chunk.extend_from_slice(&buf);
        buf = chunk;

        let text = String::from_utf8_lossy(&buf);
        for line in text.lines().rev() {
            if let Some(count) = extract_codex_token_count(line) {
                return Some(count);
            }
        }

        pos = start;
    }

    None
}

fn extract_codex_token_count(line: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type").and_then(|v| v.as_str()) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
        return None;
    }

    payload
        .get("info")
        .and_then(|info| info.get("last_token_usage"))
        .and_then(|usage| usage.get("total_tokens"))
        .and_then(|v| v.as_u64())
        .or_else(|| {
            payload
                .get("info")
                .and_then(|info| info.get("total_tokens"))
                .and_then(|v| v.as_u64())
        })
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

#[cfg(test)]
mod tests {
    #[test]
    fn action_time_uses_recorded_output_and_ignores_session_settings() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("activity.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-10-20T01:00:00Z\",\"payload\":{\"type\":\"user_message\"}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-10-20T02:00:00Z\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-10-23T01:00:00Z\",\"payload\":{\"type\":\"thread_settings_applied\"}}\n",
            ),
        ).unwrap();
        let first = super::read_last_action_at(&path).unwrap();
        assert_eq!(first, 1792461600000);
        // The user-message cache must stay independent of the action cache.
        assert_eq!(super::read_last_user_message_at(&path), Some(first - 3600000));
        assert_eq!(super::read_last_action_at(&path), Some(first));
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{{\"type\":\"event_msg\",\"timestamp\":\"2026-10-23T02:00:00Z\",\"payload\":{{\"type\":\"task_complete\",\"last_agent_message\":\"Done\"}}}}").unwrap();
        assert_eq!(super::read_last_action_at(&path), Some(first + 3 * 86_400_000));
        assert_eq!(super::read_last_user_message_at(&path), Some(first - 3600000));
    }

    #[test]
    fn opening_a_session_preserves_the_last_agent_action_time() {
        use serde_json::json;
        use std::io::Write;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("activity.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "timestamp": "2026-10-24T07:03:40.759Z",
                "payload": {"type": "message", "role": "assistant"}
            })
        )
        .unwrap();
        let finished = super::read_last_action_at(&path).unwrap();

        // Opening the old conversation can append a fresh lifecycle marker
        // without a prompt, output, or any other agent action.
        for payload in [
            json!({"type": "task_started"}),
            json!({"type": "thread_settings_applied"}),
            json!({"type": "item_completed", "item": {"type": "ContextCompaction"}}),
            json!({"type": "task_complete", "last_agent_message": null}),
        ] {
            writeln!(
                file,
                "{}",
                json!({
                    "type": "event_msg", "timestamp": "2026-10-25T06:34:20.904Z", "payload": payload
                })
            )
            .unwrap();
            assert_eq!(super::read_last_action_at(&path), Some(finished));
        }
        for role in ["system", "developer", "user"] {
            writeln!(
                file,
                "{}",
                json!({
                    "type": "response_item", "timestamp": "2026-10-25T06:34:20.904Z",
                    "payload": {"type": "message", "role": role}
                })
            )
            .unwrap();
            assert_eq!(super::read_last_action_at(&path), Some(finished));
        }

        for (offset, (kind, payload)) in [
            ("event_msg", json!({"type": "user_message"})),
            (
                "event_msg",
                json!({"type": "item_completed", "item": {"type": "UserMessage"}}),
            ),
            (
                "event_msg",
                json!({"type": "item_completed", "item": {"type": "AgentMessage"}}),
            ),
            ("response_item", json!({"type": "reasoning"})),
            ("response_item", json!({"type": "custom_tool_call"})),
            ("response_item", json!({"type": "custom_tool_call_output"})),
            (
                "response_item",
                json!({"type": "message", "role": "assistant"}),
            ),
            (
                "event_msg",
                json!({"type": "task_complete", "last_agent_message": "Done"}),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let timestamp = format!("2026-10-25T06:35:{offset:02}Z");
            writeln!(
                file,
                "{}",
                json!({
                    "type": kind, "timestamp": timestamp, "payload": payload
                })
            )
            .unwrap();
            let expected = chrono::DateTime::parse_from_rfc3339(&timestamp)
                .unwrap()
                .timestamp_millis();
            assert_eq!(super::read_last_action_at(&path), Some(expected));
        }
    }

    #[test]
    fn session_file_size_tracks_growth_truncation_and_removal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rollout.jsonl");
        assert_eq!(super::session_file_size(&path), None);
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(1_200_000_000).unwrap();
        assert_eq!(super::session_file_size(&path), Some(1_200_000_000));
        file.set_len(5).unwrap();
        assert_eq!(super::session_file_size(&path), Some(5));
        std::fs::remove_file(&path).unwrap();
        assert_eq!(super::session_file_size(&path), None);
        assert_eq!(super::session_file_size(directory.path()), None);
    }

    #[test]
    fn message_time_ignores_agent_output_and_refreshes_for_identical_prompts() {
        use std::io::Write;
        let path =
            std::env::temp_dir().join(format!("codex-message-time-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&path, concat!(
            "{\"type\":\"event_msg\",\"timestamp\":\"2026-10-20T01:00:00Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"continue\"}}\n",
            "{\"type\":\"event_msg\",\"timestamp\":\"2026-10-20T02:00:00Z\",\"payload\":{\"type\":\"task_complete\"}}\n",
        )).expect("fixture");
        let first = super::read_last_user_message_at(&path).expect("message time");
        assert_eq!(first, 1792458000000);
        assert_eq!(super::read_last_user_message_at(&path), Some(first));
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open");
        writeln!(file, "{{\"type\":\"event_msg\",\"timestamp\":\"2026-10-20T03:00:00Z\",\"payload\":{{\"type\":\"user_message\",\"message\":\"continue\"}}}}").expect("append");
        assert_eq!(
            super::read_last_user_message_at(&path),
            Some(first + 7200000)
        );
        std::fs::remove_file(path).expect("cleanup");
    }

    fn unique_thread_for_title(
        conn: &rusqlite::Connection,
        title: &str,
        cwd: &str,
    ) -> Option<String> {
        super::session_for_title(conn, title, cwd)?.thread_id
    }

    #[test]
    fn duplicate_session_names_keep_the_visible_title_without_guessing_identity() {
        let conn = rusqlite::Connection::open_in_memory().expect("database");
        conn.execute_batch(
            "create table threads (id text, name text, cwd text, archived integer);
            insert into threads values ('old', 'Test title', '/project', 0),
                ('new', 'Test title', '/project', 0);",
        )
        .expect("fixtures");
        for title in [
            "Test title | project",
            "\u{2839} Test title | project",
            "[ . ] Action Required | Test title | project",
            "[ ! ] Action Required | Test title | project",
        ] {
            let session =
                super::session_for_title(&conn, title, "/project").expect("visible session name");
            assert_eq!(session.name, "Test title");
            assert!(session.thread_id.is_none());
        }
        assert!(
            super::session_for_title(&conn, "Test title | project", "/another-project").is_none()
        );
    }

    #[test]
    fn generated_names_arrive_after_session_creation_and_older_schemas_still_resolve() {
        let conn = rusqlite::Connection::open_in_memory().expect("database");
        conn.execute_batch("create table threads (id text, created_at integer, first_user_message text, rollout_path text);
            insert into threads values ('thread', 1, 'A very long initial prompt', null);").expect("fixtures");
        let thread = super::read_codex_thread_from_db(&conn, "thread").expect("thread");
        assert!(thread.name.is_none());
        assert_eq!(thread.first_user_message, "A very long initial prompt");
        conn.execute_batch("alter table threads add column name text;")
            .expect("schema");
        assert!(super::read_codex_thread_from_db(&conn, "thread")
            .expect("thread")
            .name
            .is_none());
        conn.execute(
            "update threads set name = 'Repair state' where id = 'thread'",
            [],
        )
        .expect("generated name");
        assert_eq!(
            super::read_codex_thread_from_db(&conn, "thread")
                .expect("thread")
                .name
                .as_deref(),
            Some("Repair state")
        );
        conn.execute(
            "update threads set name = 'Updated name' where id = 'thread'",
            [],
        )
        .expect("rename");
        assert_eq!(
            super::read_codex_thread_from_db(&conn, "thread")
                .expect("thread")
                .name
                .as_deref(),
            Some("Updated name")
        );
    }

    #[test]
    fn daemon_session_titles_require_unique_names_in_the_pane_directory() {
        let conn = rusqlite::Connection::open_in_memory().expect("database");
        conn.execute_batch(
            "create table threads (id text, name text, cwd text, archived integer);
            insert into threads values ('first', 'Fix state | details', '/project', 0),
                ('other-directory', 'Fix state | details', '/elsewhere', 0),
                ('archived', 'Fix state | details', '/project', 1),
                ('unicode', '修正 state', '/project', 0);",
        )
        .expect("fixtures");
        for title in [
            "Fix state | details | project",
            "\u{2839} Fix state | details | project",
            "[ . ] Action Required | Fix state | details | project",
            "[ ! ] Action Required | Fix state | details | project",
        ] {
            assert_eq!(
                unique_thread_for_title(&conn, title, "/project").as_deref(),
                Some("first")
            );
        }
        assert_eq!(
            unique_thread_for_title(&conn, "修正 state | project", "/project").as_deref(),
            Some("unicode")
        );
        assert_eq!(
            unique_thread_for_title(&conn, "Fix state | details | project", "/missing"),
            None
        );
        assert_eq!(unique_thread_for_title(&conn, "hostname", "/project"), None);
        assert_eq!(
            unique_thread_for_title(&conn, "Fix state | project", "/project"),
            None
        );
        conn.execute(
            "insert into threads values ('duplicate', 'Fix state | details', '/project', 0)",
            [],
        )
        .expect("duplicate");
        assert_eq!(
            unique_thread_for_title(&conn, "Fix state | details | project", "/project"),
            None
        );
    }

    use super::{read_codex_last_query_from_tail, read_completed_turn_after};
    use std::fs;
    use std::io::Write;

    #[test]
    fn reads_latest_model_before_long_tool_output() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("rollout.jsonl");
        let old = r#"{"type":"turn_context","payload":{"model":"old-model","effort":"low"}}"#;
        let latest = r#"{"type":"turn_context","payload":{"model":"gpt-6-astra","effort":"high"}}"#;
        let output = format!(
            "{{\"type\":\"response_item\",\"text\":\"{}\"}}\n",
            "x".repeat(70_000)
        );
        fs::write(
            &path,
            format!("{old}\n{latest}\n{}{{\"partial\":", output.repeat(10)),
        )
        .expect("rollout");
        assert_eq!(
            super::read_codex_rollout_selection(&path),
            (Some("gpt-6-astra".into()), Some("high".into()))
        );
    }

    #[test]
    fn codex_completion_requires_a_later_terminal_lifecycle_event() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("rollout.jsonl");
        let event = |kind: &str, seconds: u64| {
            format!(
                "{}\n",
                serde_json::json!({
                    "timestamp": format!("2026-07-07T00:00:{seconds:02}.000Z"),
                    "type": "event_msg",
                    "payload": {"type": kind}
                })
            )
        };
        let hook_timestamp = chrono::DateTime::parse_from_rfc3339("2026-07-07T00:00:00Z")
            .expect("timestamp")
            .timestamp_millis() as u64;
        for kind in ["turn_aborted", "task_complete"] {
            let finished = event(kind, 2);
            fs::write(&path, event("task_started", 0) + &finished).expect("rollout");
            assert_eq!(
                read_completed_turn_after(&path, hook_timestamp + 1_000),
                Some(hook_timestamp + 2_000)
            );
            assert_eq!(
                read_completed_turn_after(&path, hook_timestamp + 2_000),
                None
            );
            assert_eq!(
                read_completed_turn_after(&path, hook_timestamp + 3_000),
                None
            );

            fs::write(&path, finished.clone() + &event("task_started", 3)).expect("rollout");
            assert_eq!(read_completed_turn_after(&path, hook_timestamp), None);
            fs::write(&path, finished + "{\"type\":\"event_msg\"").expect("partial rollout");
            assert_eq!(read_completed_turn_after(&path, hook_timestamp), None);
        }
        fs::write(&path, event("task_started", 0) + &event("token_count", 3))
            .expect("running rollout");
        assert_eq!(read_completed_turn_after(&path, hook_timestamp), None);
        assert_eq!(
            read_completed_turn_after(&directory.path().join("missing"), hook_timestamp),
            None
        );
    }

    #[test]
    fn codex_completion_reads_bounded_tail_past_unrelated_output() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("rollout.jsonl");
        let finished = r#"{"timestamp":"2026-07-07T00:00:02Z","type":"event_msg","payload":{"type":"turn_aborted"}}"#;
        fs::write(
            &path,
            format!(
                "{}\n{finished}\nnot json\n{{\"type\":\"response_item\"}}\n",
                "x".repeat(70_000)
            ),
        )
        .expect("rollout");
        assert!(read_completed_turn_after(&path, 0).is_some());
    }

    #[test]
    fn reads_latest_matching_query_from_history_tail() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("history.jsonl");
        let mut file = fs::File::create(&path).expect("history file");
        writeln!(
            file,
            "{}",
            r#"{"session_id":"other","text":"not this session"}"#
        )
        .expect("write history");
        writeln!(
            file,
            "{}",
            r#"{"session_id":"thread-1","text":"first prompt"}"#
        )
        .expect("write history");
        writeln!(
            file,
            "{}",
            r#"{"session_id":"thread-1","text":"latest prompt"}"#
        )
        .expect("write history");

        let length = fs::metadata(&path).expect("history metadata").len();
        assert_eq!(
            read_codex_last_query_from_tail(&path, "thread-1", length),
            Some(Some("latest prompt".to_string()))
        );
    }

    #[test]
    fn skips_malformed_history_lines_when_reading_tail() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("history.jsonl");
        let mut file = fs::File::create(&path).expect("history file");
        writeln!(file, "not json").expect("write history");
        writeln!(
            file,
            "{}",
            r#"{"session_id":"thread-1","text":"latest prompt"}"#
        )
        .expect("write history");

        let length = fs::metadata(&path).expect("history metadata").len();
        assert_eq!(
            read_codex_last_query_from_tail(&path, "thread-1", length),
            Some(Some("latest prompt".to_string()))
        );
    }
}
