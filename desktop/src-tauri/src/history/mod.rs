use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    #[serde(alias = "job_name")]
    pub job_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    pub trigger: String,
    pub stdout: String,
    pub stderr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
}

pub struct HistoryStore {
    conn: Connection,
}

impl HistoryStore {
    pub fn new() -> Result<Self, String> {
        let path = Self::db_path().ok_or("Could not determine data directory")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create data directory: {}", e))?;
        }

        let conn =
            Connection::open(&path).map_err(|e| format!("Failed to open database: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                job_name TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                exit_code INTEGER,
                trigger_type TEXT NOT NULL,
                stdout TEXT NOT NULL DEFAULT '',
                stderr TEXT NOT NULL DEFAULT '',
                pane_id TEXT,
                log_path TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_name);
            CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        // Add pane_id column if missing (migration for existing databases)
        conn.execute_batch("ALTER TABLE runs ADD COLUMN pane_id TEXT;")
            .ok();
        conn.execute_batch("ALTER TABLE runs ADD COLUMN log_path TEXT;")
            .ok();

        // Auto-prune entries older than 30 days
        conn.execute(
            "DELETE FROM runs WHERE started_at < datetime('now', '-30 days')",
            [],
        )
        .ok();

        // Clean up stale reattach records (unfinished with no output)
        conn.execute(
            "DELETE FROM runs WHERE trigger_type = 'reattach' AND finished_at IS NULL AND stdout = '' AND stderr = ''",
            [],
        )
        .ok();

        let store = Self { conn };
        crate::agent::migrate_legacy_agent_storage();
        store.backfill_orphan_logs();
        Ok(store)
    }

    /// One-shot scan of ~/.config/clawtab/jobs/<slug>/logs/ that pairs
    /// timestamped `YYYYMMDDTHHMMSSZ-exitN.log` files (written by older
    /// builds or by user shell scripts) with existing runs by their
    /// `started_at`. Backfills `log_path`, `finished_at`, and `exit_code`
    /// so previously orphaned "interrupted" rows become clickable.
    fn backfill_orphan_logs(&self) {
        let Some(jobs_dir) = crate::config::jobs::JobsConfig::jobs_dir_public() else {
            return;
        };
        // Walk the tree looking for any `logs/` directory. Jobs can live one
        // level deep (slug=name) or nested in groups (slug=group/name).
        let mut logs_dirs: Vec<std::path::PathBuf> = Vec::new();
        let mut stack: Vec<std::path::PathBuf> = vec![jobs_dir.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if path.file_name().and_then(|s| s.to_str()) == Some("logs") {
                    logs_dirs.push(path);
                } else {
                    stack.push(path);
                }
            }
        }
        for logs_dir in logs_dirs {
            let Ok(files) = std::fs::read_dir(&logs_dir) else {
                continue;
            };
            // slug is the path from jobs_dir to the parent of logs/
            let slug_path = match logs_dir.parent() {
                Some(p) => p,
                None => continue,
            };
            let slug = match slug_path.strip_prefix(&jobs_dir) {
                Ok(p) => p.to_string_lossy().into_owned(),
                Err(_) => continue,
            };
            for file in files.flatten() {
                let path = file.path();
                let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                // Pattern: 20260511T130901Z-exit1.log
                let Some(stem) = name.strip_suffix(".log") else {
                    continue;
                };
                let (ts_part, exit_part) = match stem.split_once("-exit") {
                    Some((a, b)) => (a, Some(b)),
                    None => (stem, None),
                };
                // ts_part must be 16 chars: YYYYMMDDTHHMMSSZ
                if ts_part.len() != 16 || !ts_part.ends_with('Z') {
                    continue;
                }
                // Convert to RFC3339-ish prefix for LIKE match: 2026-05-11T13:09:01
                let iso_prefix = format!(
                    "{}-{}-{}T{}:{}:{}",
                    &ts_part[0..4],
                    &ts_part[4..6],
                    &ts_part[6..8],
                    &ts_part[9..11],
                    &ts_part[11..13],
                    &ts_part[13..15],
                );
                let pattern = format!("{}%", iso_prefix);
                let path_str = path.to_string_lossy().into_owned();
                let exit_code: Option<i32> = exit_part.and_then(|s| s.parse().ok());
                // Only update rows still missing a log_path so we don't overwrite
                // streaming logs from current runs.
                let _ = self.conn.execute(
                    "UPDATE runs
                     SET log_path = ?1,
                         finished_at = COALESCE(finished_at, started_at),
                         exit_code = COALESCE(exit_code, ?2)
                     WHERE job_name = ?3
                       AND started_at LIKE ?4
                       AND log_path IS NULL",
                    params![path_str, exit_code, slug, pattern],
                );
            }
        }
    }

    fn db_path() -> Option<PathBuf> {
        crate::config::config_dir().map(|p| p.join("history.db"))
    }

    pub fn insert(&self, record: &RunRecord) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO runs (id, job_name, started_at, finished_at, exit_code, trigger_type, stdout, stderr, pane_id, log_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    record.id,
                    record.job_id,
                    record.started_at,
                    record.finished_at,
                    record.exit_code,
                    record.trigger,
                    record.stdout,
                    record.stderr,
                    record.pane_id,
                    record.log_path,
                ],
            )
            .map_err(|e| format!("Failed to insert run record: {}", e))?;
        Ok(())
    }

    pub fn update_pane_id(&self, id: &str, pane_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE runs SET pane_id = ?1 WHERE id = ?2",
                params![pane_id, id],
            )
            .map_err(|e| format!("Failed to update pane_id: {}", e))?;
        Ok(())
    }

    pub fn update_log_path(&self, id: &str, log_path: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE runs SET log_path = ?1 WHERE id = ?2",
                params![log_path, id],
            )
            .map_err(|e| format!("Failed to update log_path: {}", e))?;
        Ok(())
    }

    pub fn update_finished(
        &self,
        id: &str,
        finished_at: &str,
        exit_code: Option<i32>,
        stdout: &str,
        stderr: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE runs SET finished_at = ?1, exit_code = ?2, stdout = ?3, stderr = ?4 WHERE id = ?5",
                params![finished_at, exit_code, stdout, stderr, id],
            )
            .map_err(|e| format!("Failed to update run record: {}", e))?;
        Ok(())
    }

    pub fn get_recent(&self, limit: usize) -> Result<Vec<RunRecord>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, job_name, started_at, finished_at, exit_code, trigger_type, stdout, stderr, pane_id, log_path
                 FROM runs ORDER BY started_at DESC LIMIT ?1",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok(RunRecord {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    exit_code: row.get(4)?,
                    trigger: row.get(5)?,
                    stdout: row.get(6)?,
                    stderr: row.get(7)?,
                    pane_id: row.get(8)?,
                    log_path: row.get(9)?,
                })
            })
            .map_err(|e| format!("Failed to query history: {}", e))?;

        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(records)
    }

    pub fn get_by_id(&self, id: &str) -> Result<Option<RunRecord>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, job_name, started_at, finished_at, exit_code, trigger_type, stdout, stderr, pane_id, log_path
                 FROM runs WHERE id = ?1",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut rows = stmt
            .query_map(params![id], |row| {
                Ok(RunRecord {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    exit_code: row.get(4)?,
                    trigger: row.get(5)?,
                    stdout: row.get(6)?,
                    stderr: row.get(7)?,
                    pane_id: row.get(8)?,
                    log_path: row.get(9)?,
                })
            })
            .map_err(|e| format!("Failed to query history: {}", e))?;

        match rows.next() {
            Some(Ok(record)) => Ok(Some(record)),
            Some(Err(e)) => Err(format!("Failed to read row: {}", e)),
            None => Ok(None),
        }
    }

    pub fn get_by_job_id(&self, job_id: &str, limit: usize) -> Result<Vec<RunRecord>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, job_name, started_at, finished_at, exit_code, trigger_type, stdout, stderr, pane_id, log_path
                 FROM runs WHERE job_name = ?1 ORDER BY started_at DESC LIMIT ?2",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map(params![job_id, limit as i64], |row| {
                Ok(RunRecord {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    exit_code: row.get(4)?,
                    trigger: row.get(5)?,
                    stdout: row.get(6)?,
                    stderr: row.get(7)?,
                    pane_id: row.get(8)?,
                    log_path: row.get(9)?,
                })
            })
            .map_err(|e| format!("Failed to query history: {}", e))?;

        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(records)
    }

    pub fn get_unfinished_by_job(&self, job_id: &str) -> Result<Option<RunRecord>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, job_name, started_at, finished_at, exit_code, trigger_type, stdout, stderr, pane_id, log_path
                 FROM runs WHERE job_name = ?1 AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut rows = stmt
            .query_map(params![job_id], |row| {
                Ok(RunRecord {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    exit_code: row.get(4)?,
                    trigger: row.get(5)?,
                    stdout: row.get(6)?,
                    stderr: row.get(7)?,
                    pane_id: row.get(8)?,
                    log_path: row.get(9)?,
                })
            })
            .map_err(|e| format!("Failed to query history: {}", e))?;

        match rows.next() {
            Some(Ok(record)) => Ok(Some(record)),
            Some(Err(e)) => Err(format!("Failed to read row: {}", e)),
            None => Ok(None),
        }
    }

    pub fn get_unfinished_with_pane(&self) -> Result<Vec<RunRecord>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, job_name, started_at, finished_at, exit_code, trigger_type, stdout, stderr, pane_id, log_path
                 FROM runs WHERE finished_at IS NULL AND pane_id IS NOT NULL ORDER BY started_at DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(RunRecord {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    exit_code: row.get(4)?,
                    trigger: row.get(5)?,
                    stdout: row.get(6)?,
                    stderr: row.get(7)?,
                    pane_id: row.get(8)?,
                    log_path: row.get(9)?,
                })
            })
            .map_err(|e| format!("Failed to query history: {}", e))?;

        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(records)
    }

    /// Map of `pane_id` -> `started_at` for every history row of `job_id`.
    /// Lets the orphan sweep order live tmux panes by their authoritative run
    /// start time (pid-based ordering is unreliable due to wraparound).
    pub fn pane_started_at_for_job(
        &self,
        job_id: &str,
    ) -> Result<std::collections::HashMap<String, String>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT pane_id, started_at FROM runs
                 WHERE job_name = ?1 AND pane_id IS NOT NULL",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let rows = stmt
            .query_map(params![job_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("Failed to query pane started_at: {}", e))?;
        let mut map = std::collections::HashMap::new();
        for r in rows {
            let (pid, ts) = r.map_err(|e| format!("Failed to read row: {}", e))?;
            map.insert(pid, ts);
        }
        Ok(map)
    }

    pub fn delete_by_id(&self, id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM runs WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete run record: {}", e))?;
        Ok(())
    }

    pub fn delete_by_ids(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!("DELETE FROM runs WHERE id IN ({})", placeholders.join(", "));
        let params: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        self.conn
            .execute(&sql, params.as_slice())
            .map_err(|e| format!("Failed to delete run records: {}", e))?;
        Ok(())
    }

    pub fn prune_job_to_limit(&self, job_id: &str, keep: u32) -> Result<Vec<String>, String> {
        if keep == 0 {
            return Ok(Vec::new());
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT pane_id FROM runs
                 WHERE job_name = ?1
                   AND id NOT IN (
                     SELECT id FROM runs
                     WHERE job_name = ?1
                     ORDER BY started_at DESC
                     LIMIT ?2
                   )
                   AND pane_id IS NOT NULL",
            )
            .map_err(|e| format!("Failed to prepare prune query: {}", e))?;
        let pane_ids: Vec<String> = stmt
            .query_map(params![job_id, keep as i64], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query pruned panes: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        self.conn
            .execute(
                "DELETE FROM runs
                 WHERE job_name = ?1
                   AND id NOT IN (
                     SELECT id FROM runs
                     WHERE job_name = ?1
                     ORDER BY started_at DESC
                     LIMIT ?2
                   )",
                params![job_id, keep as i64],
            )
            .map_err(|e| format!("Failed to prune job history: {}", e))?;
        Ok(pane_ids)
    }

    pub fn clear(&self) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM runs", [])
            .map_err(|e| format!("Failed to clear history: {}", e))?;
        Ok(())
    }
}
