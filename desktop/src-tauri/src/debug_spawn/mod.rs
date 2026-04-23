use rusqlite::{params, Connection};
use serde::Serialize;
use std::ffi::OsStr;
use std::process::{Command, Output};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const RETENTION_SECS: i64 = 600;
const STDERR_HEAD_BYTES: usize = 200;

static STORE: OnceLock<Mutex<Connection>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
pub struct SpawnEventRow {
    pub id: i64,
    pub ts_start_ms: i64,
    pub duration_ms: i64,
    pub program: String,
    pub args: String,
    pub callsite: String,
    pub exit_code: Option<i32>,
    pub stderr_head: String,
    pub pid: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgramCount {
    pub program: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallsiteStat {
    pub callsite: String,
    pub count: i64,
    pub total_ms: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SpawnSummary {
    pub total: i64,
    pub window_secs: i64,
    pub calls_per_sec_1s: f64,
    pub calls_per_sec_10s: f64,
    pub top_programs: Vec<ProgramCount>,
    pub top_callsites_by_count: Vec<CallsiteStat>,
    pub top_callsites_by_duration: Vec<CallsiteStat>,
}

pub fn init() -> Result<(), String> {
    if STORE.get().is_some() {
        return Ok(());
    }
    let path = crate::config::config_dir()
        .ok_or_else(|| "config dir unavailable".to_string())?
        .join("spawn_debug.db");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create spawn debug dir: {}", e))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("open spawn_debug.db: {}", e))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS spawn_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts_start_ms INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            program TEXT NOT NULL,
            args TEXT NOT NULL,
            callsite TEXT NOT NULL,
            exit_code INTEGER,
            stderr_head TEXT NOT NULL DEFAULT '',
            pid INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_spawn_ts ON spawn_events(ts_start_ms);
        CREATE INDEX IF NOT EXISTS idx_spawn_program ON spawn_events(program);
        PRAGMA journal_mode = WAL;",
    )
    .map_err(|e| format!("create spawn_events: {}", e))?;
    STORE
        .set(Mutex::new(conn))
        .map_err(|_| "spawn store already initialized".to_string())?;
    Ok(())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn args_to_string<I, S>(args: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .map(|a| a.as_ref().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

struct SpawnRecord<'a> {
    program: &'a str,
    args_str: String,
    callsite: &'static str,
    ts_start_ms: i64,
    duration_ms: i64,
    exit_code: Option<i32>,
    stderr: &'a [u8],
    pid: Option<i64>,
}

fn record(r: SpawnRecord) {
    let Some(store) = STORE.get() else {
        return;
    };
    let head_len = r.stderr.len().min(STDERR_HEAD_BYTES);
    let stderr_head = String::from_utf8_lossy(&r.stderr[..head_len]).into_owned();
    let Ok(conn) = store.lock() else {
        return;
    };
    let _ = conn.execute(
        "INSERT INTO spawn_events
           (ts_start_ms, duration_ms, program, args, callsite, exit_code, stderr_head, pid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            r.ts_start_ms,
            r.duration_ms,
            r.program,
            r.args_str,
            r.callsite,
            r.exit_code,
            stderr_head,
            r.pid
        ],
    );
    let cutoff = r.ts_start_ms - RETENTION_SECS * 1000;
    let _ = conn.execute(
        "DELETE FROM spawn_events WHERE ts_start_ms < ?1",
        params![cutoff],
    );
}

/// Synchronous wrapper. Spawns `program` with `args`, captures duration/exit/stderr,
/// and records a row. Returns the process `Output` on success.
pub fn run_logged(program: &str, args: &[&str], callsite: &'static str) -> std::io::Result<Output> {
    let start = Instant::now();
    let ts = now_ms();
    let out = Command::new(program).args(args).output();
    let duration_ms = start.elapsed().as_millis() as i64;
    let args_str = args_to_string(args);
    match &out {
        Ok(output) => {
            record(SpawnRecord {
                program,
                args_str,
                callsite,
                ts_start_ms: ts,
                duration_ms,
                exit_code: output.status.code(),
                stderr: &output.stderr,
                pid: None,
            });
        }
        Err(e) => {
            let err = e.to_string();
            record(SpawnRecord {
                program,
                args_str,
                callsite,
                ts_start_ms: ts,
                duration_ms,
                exit_code: None,
                stderr: err.as_bytes(),
                pid: None,
            });
        }
    }
    out
}

pub fn list_since(since_ms: Option<i64>, limit: i64) -> Result<Vec<SpawnEventRow>, String> {
    let Some(store) = STORE.get() else {
        return Ok(Vec::new());
    };
    let conn = store
        .lock()
        .map_err(|_| "spawn store poisoned".to_string())?;
    let cutoff = since_ms.unwrap_or(now_ms() - RETENTION_SECS * 1000);
    let mut stmt = conn
        .prepare(
            "SELECT id, ts_start_ms, duration_ms, program, args, callsite, exit_code, stderr_head, pid
             FROM spawn_events
             WHERE ts_start_ms >= ?1
             ORDER BY ts_start_ms DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("prepare list: {}", e))?;
    let rows = stmt
        .query_map(params![cutoff, limit], |row| {
            Ok(SpawnEventRow {
                id: row.get(0)?,
                ts_start_ms: row.get(1)?,
                duration_ms: row.get(2)?,
                program: row.get(3)?,
                args: row.get(4)?,
                callsite: row.get(5)?,
                exit_code: row.get(6)?,
                stderr_head: row.get(7)?,
                pid: row.get(8)?,
            })
        })
        .map_err(|e| format!("query list: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("read row: {}", e))?);
    }
    Ok(out)
}

pub fn summary() -> Result<SpawnSummary, String> {
    let Some(store) = STORE.get() else {
        return Ok(SpawnSummary::default());
    };
    let conn = store
        .lock()
        .map_err(|_| "spawn store poisoned".to_string())?;
    let now = now_ms();
    let window_start = now - RETENTION_SECS * 1000;

    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM spawn_events WHERE ts_start_ms >= ?1",
            params![window_start],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let count_in = |millis: i64| -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM spawn_events WHERE ts_start_ms >= ?1",
            params![now - millis],
            |r| r.get(0),
        )
        .unwrap_or(0)
    };
    let calls_1s = count_in(1_000) as f64;
    let calls_10s = count_in(10_000) as f64 / 10.0;

    let top_programs = {
        let mut stmt = conn
            .prepare(
                "SELECT program, COUNT(*) FROM spawn_events
                 WHERE ts_start_ms >= ?1
                 GROUP BY program ORDER BY COUNT(*) DESC LIMIT 5",
            )
            .map_err(|e| format!("prepare top programs: {}", e))?;
        let rows = stmt
            .query_map(params![window_start], |row| {
                Ok(ProgramCount {
                    program: row.get(0)?,
                    count: row.get(1)?,
                })
            })
            .map_err(|e| format!("query top programs: {}", e))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {}", e))?);
        }
        out
    };

    let callsite_stat = |order: &str| -> Result<Vec<CallsiteStat>, String> {
        let sql = format!(
            "SELECT callsite, COUNT(*), SUM(duration_ms) FROM spawn_events
             WHERE ts_start_ms >= ?1
             GROUP BY callsite ORDER BY {} DESC LIMIT 5",
            order
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("prepare callsite: {}", e))?;
        let rows = stmt
            .query_map(params![window_start], |row| {
                Ok(CallsiteStat {
                    callsite: row.get(0)?,
                    count: row.get(1)?,
                    total_ms: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                })
            })
            .map_err(|e| format!("query callsite: {}", e))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {}", e))?);
        }
        Ok(out)
    };

    Ok(SpawnSummary {
        total,
        window_secs: RETENTION_SECS,
        calls_per_sec_1s: calls_1s,
        calls_per_sec_10s: calls_10s,
        top_programs,
        top_callsites_by_count: callsite_stat("COUNT(*)")?,
        top_callsites_by_duration: callsite_stat("SUM(duration_ms)")?,
    })
}

pub fn clear() -> Result<(), String> {
    let Some(store) = STORE.get() else {
        return Ok(());
    };
    let conn = store
        .lock()
        .map_err(|_| "spawn store poisoned".to_string())?;
    conn.execute("DELETE FROM spawn_events", [])
        .map_err(|e| format!("clear: {}", e))?;
    Ok(())
}
