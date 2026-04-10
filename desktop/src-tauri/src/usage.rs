use std::path::PathBuf;

use chrono::Utc;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::claude_usage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEntry {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderUsageSnapshot {
    pub provider: String,
    pub status: String,
    pub summary: String,
    pub note: Option<String>,
    pub entries: Vec<UsageEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSnapshot {
    pub refreshed_at: String,
    pub claude: ProviderUsageSnapshot,
    pub codex: ProviderUsageSnapshot,
    pub opencode: ProviderUsageSnapshot,
}

pub async fn fetch_usage_snapshot() -> UsageSnapshot {
    UsageSnapshot {
        refreshed_at: Utc::now().to_rfc3339(),
        claude: fetch_claude_snapshot().await,
        codex: fetch_codex_snapshot(),
        opencode: fetch_opencode_snapshot(),
    }
}

async fn fetch_claude_snapshot() -> ProviderUsageSnapshot {
    match claude_usage::fetch_usage().await {
        Ok(usage) => {
            let mut entries = Vec::new();

            entries.push(UsageEntry {
                label: "Session".to_string(),
                value: usage_bucket_text(usage.five_hour.as_ref()),
            });
            entries.push(UsageEntry {
                label: "Week".to_string(),
                value: usage_bucket_text(usage.seven_day.as_ref()),
            });

            let summary = format!(
                "Session {}, Week {}",
                usage_bucket_percent(usage.five_hour.as_ref()),
                usage_bucket_percent(usage.seven_day.as_ref())
            );

            ProviderUsageSnapshot {
                provider: "claude".to_string(),
                status: "available".to_string(),
                summary,
                note: None,
                entries,
            }
        }
        Err(err) => ProviderUsageSnapshot {
            provider: "claude".to_string(),
            status: "unavailable".to_string(),
            summary: "Usage unavailable".to_string(),
            note: Some(err),
            entries: vec![
                UsageEntry {
                    label: "Session".to_string(),
                    value: "n/a".to_string(),
                },
                UsageEntry {
                    label: "Week".to_string(),
                    value: "n/a".to_string(),
                },
            ],
        },
    }
}

fn fetch_codex_snapshot() -> ProviderUsageSnapshot {
    match read_codex_totals() {
        Ok(Some((threads, tokens))) => ProviderUsageSnapshot {
            provider: "codex".to_string(),
            status: "partial".to_string(),
            summary: format!(
                "{} tracked across {}",
                format_token_count(tokens),
                pluralize("thread", threads)
            ),
            note: Some(
                "Codex stores cumulative per-thread tokens locally, but no quota/reset usage API was found."
                    .to_string(),
            ),
            entries: vec![
                UsageEntry {
                    label: "Threads".to_string(),
                    value: threads.to_string(),
                },
                UsageEntry {
                    label: "Local Tracked Tokens".to_string(),
                    value: format_token_count(tokens),
                },
            ],
        },
        Ok(None) => ProviderUsageSnapshot {
            provider: "codex".to_string(),
            status: "unavailable".to_string(),
            summary: "No local Codex usage data".to_string(),
            note: Some("No Codex state database was found.".to_string()),
            entries: Vec::new(),
        },
        Err(err) => ProviderUsageSnapshot {
            provider: "codex".to_string(),
            status: "unavailable".to_string(),
            summary: "Usage unavailable".to_string(),
            note: Some(err),
            entries: Vec::new(),
        },
    }
}

fn fetch_opencode_snapshot() -> ProviderUsageSnapshot {
    match read_opencode_totals(7) {
        Ok(Some(stats)) => {
            let total_tokens =
                stats.input_tokens + stats.output_tokens + stats.cache_read_tokens + stats.cache_write_tokens;
            let summary = format!(
                "7d {} across {}",
                format_token_count(total_tokens),
                pluralize("session", stats.sessions)
            );

            ProviderUsageSnapshot {
                provider: "opencode".to_string(),
                status: "available".to_string(),
                summary,
                note: Some(
                    "OpenCode exposes aggregate usage stats, not quota/reset windows.".to_string(),
                ),
                entries: vec![
                    UsageEntry {
                        label: "Window".to_string(),
                        value: "Last 7 days".to_string(),
                    },
                    UsageEntry {
                        label: "Sessions".to_string(),
                        value: stats.sessions.to_string(),
                    },
                    UsageEntry {
                        label: "Messages".to_string(),
                        value: stats.messages.to_string(),
                    },
                    UsageEntry {
                        label: "Total Tokens".to_string(),
                        value: format_token_count(total_tokens),
                    },
                    UsageEntry {
                        label: "Input".to_string(),
                        value: format_token_count(stats.input_tokens),
                    },
                    UsageEntry {
                        label: "Output".to_string(),
                        value: format_token_count(stats.output_tokens),
                    },
                    UsageEntry {
                        label: "Cache Read".to_string(),
                        value: format_token_count(stats.cache_read_tokens),
                    },
                    UsageEntry {
                        label: "Cost".to_string(),
                        value: format_cost(stats.total_cost),
                    },
                ],
            }
        }
        Ok(None) => ProviderUsageSnapshot {
            provider: "opencode".to_string(),
            status: "unavailable".to_string(),
            summary: "No local OpenCode usage data".to_string(),
            note: Some("No OpenCode database was found.".to_string()),
            entries: Vec::new(),
        },
        Err(err) => ProviderUsageSnapshot {
            provider: "opencode".to_string(),
            status: "unavailable".to_string(),
            summary: "Usage unavailable".to_string(),
            note: Some(err),
            entries: Vec::new(),
        },
    }
}

fn usage_bucket_percent(bucket: Option<&claude_usage::UsageBucket>) -> String {
    bucket
        .map(|value| format!("{:.0}%", value.utilization))
        .unwrap_or_else(|| "n/a".to_string())
}

fn usage_bucket_text(bucket: Option<&claude_usage::UsageBucket>) -> String {
    match bucket {
        Some(value) => match value.resets_in_human() {
            Some(reset) => format!("{:.0}% (resets {})", value.utilization, reset),
            None => format!("{:.0}%", value.utilization),
        },
        None => "n/a".to_string(),
    }
}

fn codex_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".codex")
}

fn latest_codex_sqlite(prefix: &str) -> Option<PathBuf> {
    let dir = codex_dir();
    let entries = std::fs::read_dir(dir).ok()?;

    entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_str()?;
            if name.starts_with(prefix) && name.ends_with(".sqlite") {
                Some(path)
            } else {
                None
            }
        })
        .max_by_key(|path| {
            std::fs::metadata(path)
                .and_then(|meta| meta.modified())
                .ok()
        })
}

fn read_codex_totals() -> Result<Option<(i64, i64)>, String> {
    let Some(db_path) = latest_codex_sqlite("state_") else {
        return Ok(None);
    };

    let conn = open_read_only_sqlite(&db_path)?;
    let result = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(tokens_used), 0) FROM threads",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|err| format!("failed to read Codex usage totals: {}", err))?;

    Ok(result)
}

#[derive(Debug)]
struct OpenCodeStats {
    sessions: i64,
    messages: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    total_cost: f64,
}

fn opencode_db_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".local/share/opencode/opencode.db")
}

fn read_opencode_totals(days: i64) -> Result<Option<OpenCodeStats>, String> {
    let db_path = opencode_db_path();
    if !db_path.exists() {
        return Ok(None);
    }

    let conn = open_read_only_sqlite(&db_path)?;
    let cutoff_ms = Utc::now().timestamp_millis() - days * 24 * 60 * 60 * 1000;

    let sessions = conn
        .query_row(
            "SELECT COUNT(*) FROM session WHERE time_created >= ?1",
            [cutoff_ms],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("failed to read OpenCode session totals: {}", err))?;

    let messages = conn
        .query_row(
            "SELECT COUNT(*) FROM message WHERE time_created >= ?1",
            [cutoff_ms],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("failed to read OpenCode message totals: {}", err))?;

    let stats = conn
        .query_row(
            "SELECT
                COALESCE(SUM(CAST(json_extract(data, '$.tokens.input') AS INTEGER)), 0),
                COALESCE(SUM(CAST(json_extract(data, '$.tokens.output') AS INTEGER)), 0),
                COALESCE(SUM(CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER)), 0),
                COALESCE(SUM(CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER)), 0),
                COALESCE(SUM(CAST(json_extract(data, '$.cost') AS REAL)), 0.0)
             FROM message
             WHERE json_extract(data, '$.role') = 'assistant'
               AND time_created >= ?1",
            [cutoff_ms],
            |row| {
                Ok(OpenCodeStats {
                    sessions,
                    messages,
                    input_tokens: row.get::<_, i64>(0)?,
                    output_tokens: row.get::<_, i64>(1)?,
                    cache_read_tokens: row.get::<_, i64>(2)?,
                    cache_write_tokens: row.get::<_, i64>(3)?,
                    total_cost: row.get::<_, f64>(4)?,
                })
            },
        )
        .map_err(|err| format!("failed to read OpenCode token totals: {}", err))?;

    Ok(Some(stats))
}

fn open_read_only_sqlite(path: &PathBuf) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|err| format!("failed to open {}: {}", path.display(), err))
}

fn format_token_count(value: i64) -> String {
    format_compact_number(value as f64)
}

fn format_cost(value: f64) -> String {
    format!("${:.2}", value)
}

fn format_compact_number(value: f64) -> String {
    let abs = value.abs();
    if abs >= 1_000_000_000.0 {
        format!("{:.1}B", value / 1_000_000_000.0)
    } else if abs >= 1_000_000.0 {
        format!("{:.1}M", value / 1_000_000.0)
    } else if abs >= 1_000.0 {
        format!("{:.1}K", value / 1_000.0)
    } else {
        format!("{:.0}", value)
    }
}

fn pluralize(noun: &str, count: i64) -> String {
    if count == 1 {
        format!("1 {}", noun)
    } else {
        format!("{} {}s", count, noun)
    }
}
