use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use chrono::{DateTime, TimeZone, Utc};
use reqwest::header::{ACCEPT, AUTHORIZATION};
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
    pub zai: ProviderUsageSnapshot,
}

pub async fn fetch_usage_snapshot(zai_token: Option<String>) -> UsageSnapshot {
    let (claude, codex, opencode, zai) = tokio::join!(
        fetch_claude_snapshot(),
        fetch_codex_snapshot(),
        fetch_opencode_snapshot(),
        fetch_zai_snapshot(zai_token),
    );

    UsageSnapshot {
        refreshed_at: Utc::now().to_rfc3339(),
        claude,
        codex,
        opencode,
        zai,
    }
}

async fn fetch_claude_snapshot() -> ProviderUsageSnapshot {
    match claude_usage::fetch_usage().await {
        Ok(usage) => ProviderUsageSnapshot {
            provider: "claude".to_string(),
            status: "available".to_string(),
            summary: format!(
                "Session {}, Week {}",
                usage_bucket_percent(usage.five_hour.as_ref()),
                usage_bucket_percent(usage.seven_day.as_ref())
            ),
            note: None,
            entries: vec![
                UsageEntry {
                    label: "Session".to_string(),
                    value: usage_bucket_text(usage.five_hour.as_ref()),
                },
                UsageEntry {
                    label: "Week".to_string(),
                    value: usage_bucket_text(usage.seven_day.as_ref()),
                },
            ],
        },
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

async fn fetch_codex_snapshot() -> ProviderUsageSnapshot {
    match tokio::task::spawn_blocking(read_codex_rpc_snapshot).await {
        Ok(Ok(snapshot)) => snapshot,
        Ok(Err(rpc_err)) => fallback_codex_snapshot(rpc_err),
        Err(err) => fallback_codex_snapshot(format!("Codex RPC task failed: {}", err)),
    }
}

fn fallback_codex_snapshot(rpc_err: String) -> ProviderUsageSnapshot {
    match read_codex_totals() {
        Ok(Some((threads, tokens))) => ProviderUsageSnapshot {
            provider: "codex".to_string(),
            status: "partial".to_string(),
            summary: format!(
                "{} tracked across {}",
                format_token_count(tokens),
                pluralize("thread", threads)
            ),
            note: Some(format!(
                "Codex app-server quota probe failed ({}). Falling back to local tracked thread tokens.",
                rpc_err
            )),
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
            summary: "Usage unavailable".to_string(),
            note: Some(format!("{} No Codex state database was found.", rpc_err)),
            entries: Vec::new(),
        },
        Err(db_err) => ProviderUsageSnapshot {
            provider: "codex".to_string(),
            status: "unavailable".to_string(),
            summary: "Usage unavailable".to_string(),
            note: Some(format!("{} {}", rpc_err, db_err)),
            entries: Vec::new(),
        },
    }
}

fn read_codex_rpc_snapshot() -> Result<ProviderUsageSnapshot, String> {
    let mut child = Command::new("codex")
        .args(["-s", "read-only", "-a", "untrusted", "app-server"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to start codex app-server: {}", err))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open codex app-server stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open codex app-server stdout".to_string())?;

    write_jsonrpc(
        &mut stdin,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "clawtab",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }
        }),
    )?;
    write_jsonrpc(
        &mut stdin,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "account/read",
            "params": {}
        }),
    )?;
    write_jsonrpc(
        &mut stdin,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "account/rateLimits/read"
        }),
    )?;
    drop(stdin);

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut account: Option<CodexAccountReadResult> = None;
    let mut limits: Option<CodexRateLimitReadResult> = None;

    while account.is_none() || limits.is_none() {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|err| format!("failed reading codex app-server output: {}", err))?;
        if bytes == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if value.get("id").and_then(|v| v.as_i64()) == Some(2) {
            if let Some(result) = value.get("result") {
                account = serde_json::from_value(result.clone()).ok();
            }
        } else if value.get("id").and_then(|v| v.as_i64()) == Some(3) {
            if let Some(result) = value.get("result") {
                limits = serde_json::from_value(result.clone()).ok();
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();

    let account = account.ok_or_else(|| "codex account/read did not return a result".to_string())?;
    let limits =
        limits.ok_or_else(|| "codex account/rateLimits/read did not return a result".to_string())?;
    let snapshot = limits
        .rate_limits_by_limit_id
        .as_ref()
        .and_then(|items| items.get("codex"))
        .cloned()
        .unwrap_or(limits.rate_limits);

    let primary_text = codex_window_text(snapshot.primary.as_ref());
    let secondary_text = codex_window_text(snapshot.secondary.as_ref());
    let plan_text = account
        .account
        .as_ref()
        .and_then(|acct| acct.plan_type())
        .or(snapshot.plan_type.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let credits_text = snapshot
        .credits
        .as_ref()
        .map(format_codex_credits)
        .unwrap_or_else(|| "n/a".to_string());

    Ok(ProviderUsageSnapshot {
        provider: "codex".to_string(),
        status: "available".to_string(),
        summary: format!(
            "Session {}, Week {}",
            codex_window_percent(snapshot.primary.as_ref()),
            codex_window_percent(snapshot.secondary.as_ref())
        ),
        note: account.account.and_then(|acct| acct.email()),
        entries: vec![
            UsageEntry {
                label: "Plan".to_string(),
                value: title_case_words(&plan_text),
            },
            UsageEntry {
                label: "Session".to_string(),
                value: primary_text,
            },
            UsageEntry {
                label: "Week".to_string(),
                value: secondary_text,
            },
            UsageEntry {
                label: "Credits".to_string(),
                value: credits_text,
            },
        ],
    })
}

fn write_jsonrpc(stdin: &mut dyn Write, value: serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string(&value)
        .map_err(|err| format!("failed to serialize codex RPC payload: {}", err))?;
    stdin
        .write_all(text.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|err| format!("failed writing codex RPC payload: {}", err))
}

async fn fetch_opencode_snapshot() -> ProviderUsageSnapshot {
    match tokio::task::spawn_blocking(|| read_opencode_totals(7)).await {
        Ok(Ok(Some(stats))) => {
            let total_tokens =
                stats.input_tokens + stats.output_tokens + stats.cache_read_tokens + stats.cache_write_tokens;
            ProviderUsageSnapshot {
                provider: "opencode".to_string(),
                status: "available".to_string(),
                summary: format!(
                    "7d {} across {}",
                    format_token_count(total_tokens),
                    pluralize("session", stats.sessions)
                ),
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
        Ok(Ok(None)) => ProviderUsageSnapshot {
            provider: "opencode".to_string(),
            status: "unavailable".to_string(),
            summary: "No local OpenCode usage data".to_string(),
            note: Some("No OpenCode database was found.".to_string()),
            entries: Vec::new(),
        },
        Ok(Err(err)) => ProviderUsageSnapshot {
            provider: "opencode".to_string(),
            status: "unavailable".to_string(),
            summary: "Usage unavailable".to_string(),
            note: Some(err),
            entries: Vec::new(),
        },
        Err(err) => ProviderUsageSnapshot {
            provider: "opencode".to_string(),
            status: "unavailable".to_string(),
            summary: "Usage unavailable".to_string(),
            note: Some(format!("OpenCode stats task failed: {}", err)),
            entries: Vec::new(),
        },
    }
}

async fn fetch_zai_snapshot(token: Option<String>) -> ProviderUsageSnapshot {
    let Some(token) = token else {
        return ProviderUsageSnapshot {
            provider: "zai".to_string(),
            status: "unavailable".to_string(),
            summary: "No z.ai token configured".to_string(),
            note: Some("Add `Z_AI_API_KEY` in ClawTab Secrets or your environment.".to_string()),
            entries: Vec::new(),
        };
    };

    match read_zai_quota(&token).await {
        Ok(snapshot) => snapshot,
        Err(err) => ProviderUsageSnapshot {
            provider: "zai".to_string(),
            status: "unavailable".to_string(),
            summary: "Usage unavailable".to_string(),
            note: Some(err),
            entries: Vec::new(),
        },
    }
}

async fn read_zai_quota(token: &str) -> Result<ProviderUsageSnapshot, String> {
    let quota_url = std::env::var("Z_AI_QUOTA_URL")
        .unwrap_or_else(|_| "https://api.z.ai/api/monitor/usage/quota/limit".to_string());

    let client = reqwest::Client::new();
    let response = client
        .get(&quota_url)
        .header(AUTHORIZATION, format!("Bearer {}", token))
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|err| format!("z.ai usage request failed: {}", err))?;

    if !response.status().is_success() {
        return Err(format!("z.ai usage API returned {}", response.status()));
    }

    let payload: ZaiQuotaEnvelope = response
        .json()
        .await
        .map_err(|err| format!("failed to parse z.ai usage response: {}", err))?;
    let data = payload
        .data
        .ok_or_else(|| "z.ai usage response did not include data".to_string())?;

    let limits = data.limits.unwrap_or_default();
    let primary = limits
        .iter()
        .find(|limit| limit.limit_type.as_deref() == Some("TOKENS_LIMIT"))
        .or_else(|| limits.first());
    let secondary = limits.iter().find(|limit| limit.limit_type.as_deref() == Some("TIME_LIMIT"));

    let summary = primary
        .map(|limit| zai_limit_summary(limit))
        .unwrap_or_else(|| "Quota data available".to_string());

    let mut entries = Vec::new();
    if let Some(plan) = data
        .plan_name
        .or(data.plan)
        .or(data.plan_type)
        .or(data.package_name)
    {
        entries.push(UsageEntry {
            label: "Plan".to_string(),
            value: plan,
        });
    }
    if let Some(limit) = primary {
        entries.push(UsageEntry {
            label: "Primary".to_string(),
            value: zai_limit_text(limit),
        });
    }
    if let Some(limit) = secondary {
        entries.push(UsageEntry {
            label: "Secondary".to_string(),
            value: zai_limit_text(limit),
        });
    }
    for detail in data.usage_details.unwrap_or_default().into_iter().take(3) {
        let label = detail
            .model
            .clone()
            .unwrap_or_else(|| "Model".to_string());
        entries.push(UsageEntry {
            label,
            value: detail.summary(),
        });
    }

    Ok(ProviderUsageSnapshot {
        provider: "zai".to_string(),
        status: "available".to_string(),
        summary,
        note: Some("Fetched from the z.ai quota API.".to_string()),
        entries,
    })
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

fn codex_window_percent(window: Option<&CodexRateLimitWindow>) -> String {
    window
        .map(|window| format!("{}%", window.used_percent))
        .unwrap_or_else(|| "n/a".to_string())
}

fn codex_window_text(window: Option<&CodexRateLimitWindow>) -> String {
    match window {
        Some(window) => match window.resets_at {
            Some(reset_ts) => {
                let reset_text = epoch_seconds_to_human(reset_ts);
                format!("{}% (resets {})", window.used_percent, reset_text)
            }
            None => format!("{}%", window.used_percent),
        },
        None => "n/a".to_string(),
    }
}

fn format_codex_credits(credits: &CodexCreditsSnapshot) -> String {
    if credits.unlimited {
        "Unlimited".to_string()
    } else if credits.has_credits {
        credits.balance.clone().unwrap_or_else(|| "Available".to_string())
    } else {
        credits.balance.clone().unwrap_or_else(|| "0".to_string())
    }
}

fn epoch_seconds_to_human(epoch_secs: i64) -> String {
    match Utc.timestamp_opt(epoch_secs, 0).single() {
        Some(target) => relative_time_from(target),
        None => "unknown".to_string(),
    }
}

fn relative_time_from(target: DateTime<Utc>) -> String {
    let delta = target - Utc::now();
    if delta.num_seconds() <= 0 {
        return "now".to_string();
    }

    let hours = delta.num_hours();
    let minutes = delta.num_minutes();
    if hours >= 24 {
        let days = hours / 24;
        let rem_hours = hours % 24;
        if rem_hours == 0 {
            format!("in {}d", days)
        } else {
            format!("in {}d {}h", days, rem_hours)
        }
    } else if hours >= 1 {
        let rem_minutes = minutes % 60;
        if rem_minutes == 0 {
            format!("in {}h", hours)
        } else {
            format!("in {}h {}m", hours, rem_minutes)
        }
    } else {
        format!("in {}m", minutes.max(1))
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
        .max_by_key(|path| std::fs::metadata(path).and_then(|meta| meta.modified()).ok())
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

fn opencode_auth_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".local/share/opencode/auth.json")
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

fn zai_limit_summary(limit: &ZaiLimit) -> String {
    let pct = limit.used_ratio_percent().map(|value| format!("{}%", value));
    let reset = limit.next_reset_time.and_then(epoch_millis_to_human);
    match (pct, reset) {
        (Some(pct), Some(reset)) => format!("{} used, resets {}", pct, reset),
        (Some(pct), None) => format!("{} used", pct),
        (None, Some(reset)) => format!("Resets {}", reset),
        (None, None) => "Quota data available".to_string(),
    }
}

fn zai_limit_text(limit: &ZaiLimit) -> String {
    let used = limit
        .used
        .map(format_numberish)
        .unwrap_or_else(|| "?".to_string());
    let total = limit
        .limit
        .map(format_numberish)
        .unwrap_or_else(|| "?".to_string());
    let base = format!("{}/{}", used, total);
    match limit.next_reset_time.and_then(epoch_millis_to_human) {
        Some(reset) => format!("{} (resets {})", base, reset),
        None => base,
    }
}

fn epoch_millis_to_human(epoch_millis: i64) -> Option<String> {
    Utc.timestamp_millis_opt(epoch_millis)
        .single()
        .map(relative_time_from)
}

fn format_token_count(value: i64) -> String {
    format_compact_number(value as f64)
}

fn format_cost(value: f64) -> String {
    format!("${:.2}", value)
}

fn format_numberish(value: f64) -> String {
    if (value.fract()).abs() < f64::EPSILON {
        format_compact_number(value)
    } else if value.abs() >= 1000.0 {
        format_compact_number(value)
    } else {
        format!("{:.2}", value)
    }
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

fn title_case_words(input: &str) -> String {
    input
        .split('_')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAccountReadResult {
    account: Option<CodexAccount>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
enum CodexAccount {
    #[serde(rename = "apiKey")]
    ApiKey,
    #[serde(rename = "chatgpt")]
    Chatgpt { email: String, plan_type: String },
}

impl CodexAccount {
    fn email(self) -> Option<String> {
        match self {
            Self::Chatgpt { email, .. } => Some(email),
            Self::ApiKey => None,
        }
    }

    fn plan_type(&self) -> Option<String> {
        match self {
            Self::Chatgpt { plan_type, .. } => Some(plan_type.clone()),
            Self::ApiKey => Some("api key".to_string()),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitReadResult {
    rate_limits: CodexRateLimitSnapshot,
    rate_limits_by_limit_id: Option<HashMap<String, CodexRateLimitSnapshot>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitSnapshot {
    primary: Option<CodexRateLimitWindow>,
    secondary: Option<CodexRateLimitWindow>,
    credits: Option<CodexCreditsSnapshot>,
    plan_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitWindow {
    used_percent: i64,
    resets_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexCreditsSnapshot {
    balance: Option<String>,
    has_credits: bool,
    unlimited: bool,
}

#[derive(Debug, Deserialize)]
struct ZaiQuotaEnvelope {
    data: Option<ZaiQuotaData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZaiQuotaData {
    limits: Option<Vec<ZaiLimit>>,
    plan_name: Option<String>,
    plan: Option<String>,
    plan_type: Option<String>,
    package_name: Option<String>,
    usage_details: Option<Vec<ZaiUsageDetail>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZaiLimit {
    limit_type: Option<String>,
    used: Option<f64>,
    limit: Option<f64>,
    next_reset_time: Option<i64>,
}

impl ZaiLimit {
    fn used_ratio_percent(&self) -> Option<i64> {
        match (self.used, self.limit) {
            (Some(used), Some(limit)) if limit > 0.0 => Some(((used / limit) * 100.0).round() as i64),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZaiUsageDetail {
    model: Option<String>,
    used: Option<f64>,
    limit: Option<f64>,
}

impl ZaiUsageDetail {
    fn summary(&self) -> String {
        match (self.used, self.limit) {
            (Some(used), Some(limit)) => format!("{}/{}", format_numberish(used), format_numberish(limit)),
            (Some(used), None) => format_numberish(used),
            _ => "n/a".to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct OpenCodeAuthFile {
    #[serde(default)]
    zai: Option<OpenCodeApiAuth>,
    #[serde(rename = "zai-coding-plan", default)]
    zai_coding_plan: Option<OpenCodeApiAuth>,
}

#[derive(Debug, Deserialize)]
struct OpenCodeApiAuth {
    key: String,
}

pub fn resolve_zai_token_from_sources(explicit_token: Option<String>) -> Option<String> {
    explicit_token
        .or_else(read_zai_token_from_opencode)
        .or_else(|| std::env::var("Z_AI_API_KEY").ok())
}

fn read_zai_token_from_opencode() -> Option<String> {
    let path = opencode_auth_path();
    let contents = std::fs::read_to_string(path).ok()?;
    let auth = serde_json::from_str::<OpenCodeAuthFile>(&contents).ok()?;
    auth.zai_coding_plan
        .map(|entry| entry.key)
        .or_else(|| auth.zai.map(|entry| entry.key))
}
