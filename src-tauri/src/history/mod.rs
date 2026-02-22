use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub job_name: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    pub trigger: String,
    pub stdout: String,
    pub stderr: String,
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
                stderr TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_name);
            CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        // Auto-prune entries older than 30 days
        conn.execute(
            "DELETE FROM runs WHERE started_at < datetime('now', '-30 days')",
            [],
        )
        .ok();

        Ok(Self { conn })
    }

    fn db_path() -> Option<PathBuf> {
        crate::config::config_dir().map(|p| p.join("history.db"))
    }

    pub fn insert(&self, record: &RunRecord) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO runs (id, job_name, started_at, finished_at, exit_code, trigger_type, stdout, stderr)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    record.id,
                    record.job_name,
                    record.started_at,
                    record.finished_at,
                    record.exit_code,
                    record.trigger,
                    record.stdout,
                    record.stderr,
                ],
            )
            .map_err(|e| format!("Failed to insert run record: {}", e))?;
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
                "SELECT id, job_name, started_at, finished_at, exit_code, trigger_type, stdout, stderr
                 FROM runs ORDER BY started_at DESC LIMIT ?1",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok(RunRecord {
                    id: row.get(0)?,
                    job_name: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    exit_code: row.get(4)?,
                    trigger: row.get(5)?,
                    stdout: row.get(6)?,
                    stderr: row.get(7)?,
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
                "SELECT id, job_name, started_at, finished_at, exit_code, trigger_type, stdout, stderr
                 FROM runs WHERE id = ?1",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let mut rows = stmt
            .query_map(params![id], |row| {
                Ok(RunRecord {
                    id: row.get(0)?,
                    job_name: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    exit_code: row.get(4)?,
                    trigger: row.get(5)?,
                    stdout: row.get(6)?,
                    stderr: row.get(7)?,
                })
            })
            .map_err(|e| format!("Failed to query history: {}", e))?;

        match rows.next() {
            Some(Ok(record)) => Ok(Some(record)),
            Some(Err(e)) => Err(format!("Failed to read row: {}", e)),
            None => Ok(None),
        }
    }

    pub fn get_by_job_name(&self, job_name: &str, limit: usize) -> Result<Vec<RunRecord>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, job_name, started_at, finished_at, exit_code, trigger_type, stdout, stderr
                 FROM runs WHERE job_name = ?1 ORDER BY started_at DESC LIMIT ?2",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows = stmt
            .query_map(params![job_name, limit as i64], |row| {
                Ok(RunRecord {
                    id: row.get(0)?,
                    job_name: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    exit_code: row.get(4)?,
                    trigger: row.get(5)?,
                    stdout: row.get(6)?,
                    stderr: row.get(7)?,
                })
            })
            .map_err(|e| format!("Failed to query history: {}", e))?;

        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(records)
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

    pub fn clear(&self) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM runs", [])
            .map_err(|e| format!("Failed to clear history: {}", e))?;
        Ok(())
    }
}
