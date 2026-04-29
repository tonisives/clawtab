use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use chrono::{DateTime, TimeZone, Utc};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use reqwest::header::{ACCEPT, AUTHORIZATION};
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
    pub zai: ProviderUsageSnapshot,
}

pub async fn fetch_usage_snapshot(zai_token: Option<String>) -> UsageSnapshot {
    let (claude, codex, zai) = tokio::join!(
        fetch_claude_snapshot(),
        fetch_codex_snapshot(),
        fetch_zai_snapshot(zai_token),
    );

    UsageSnapshot {
        refreshed_at: Utc::now().to_rfc3339(),
        claude,
        codex,
        zai,
    }
}

async fn fetch_claude_snapshot() -> ProviderUsageSnapshot {
    match claude_usage::fetch_usage().await {
        Ok(usage) => {
            let session_pct = usage_bucket_percent(usage.five_hour.as_ref());
            let week_pct = usage_bucket_percent(usage.seven_day.as_ref());
            let session_reset = usage
                .five_hour
                .as_ref()
                .and_then(|b| b.resets_in_human());
            let summary = match session_reset {
                Some(reset) => format!(
                    "Session {} (resets {}), Week {}",
                    session_pct, reset, week_pct
                ),
                None => format!("Session {}, Week {}", session_pct, week_pct),
            };
            ProviderUsageSnapshot {
                provider: "claude".to_string(),
                status: "available".to_string(),
                summary,
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

async fn fetch_codex_snapshot() -> ProviderUsageSnapshot {
    match tokio::task::spawn_blocking(read_codex_rpc_snapshot).await {
        Ok(Ok(snapshot)) => snapshot,
        Ok(Err(rpc_err)) => fallback_codex_snapshot(rpc_err),
        Err(err) => fallback_codex_snapshot(format!("Codex RPC task failed: {}", err)),
    }
}

fn fallback_codex_snapshot(rpc_err: String) -> ProviderUsageSnapshot {
    match read_codex_status_cli_snapshot() {
        Ok(mut snapshot) => {
            snapshot.status = "available".to_string();
            snapshot.note = None;
            snapshot
        }
        Err(cli_err) => ProviderUsageSnapshot {
            provider: "codex".to_string(),
            status: "unavailable".to_string(),
            summary: "Usage unavailable".to_string(),
            note: Some(format!(
                "Codex app-server quota probe failed ({}). `codex /status` fallback also failed ({}).",
                rpc_err, cli_err
            )),
            entries: Vec::new(),
        },
    }
}

fn read_codex_rpc_snapshot() -> Result<ProviderUsageSnapshot, String> {
    let codex_binary = resolve_codex_binary();
    let mut child = Command::new(&codex_binary)
        .args(["-s", "read-only", "-a", "untrusted", "app-server"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| {
            format!(
                "failed to start codex app-server at {}: {}",
                codex_binary.display(),
                err
            )
        })?;

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

    let account =
        account.ok_or_else(|| "codex account/read did not return a result".to_string())?;
    let limits = limits
        .ok_or_else(|| "codex account/rateLimits/read did not return a result".to_string())?;
    let snapshot = limits
        .rate_limits_by_limit_id
        .as_ref()
        .and_then(|items| items.get("codex"))
        .cloned()
        .unwrap_or(limits.rate_limits);

    let (primary, secondary) = normalize_codex_windows(snapshot.primary, snapshot.secondary);
    let primary_text = codex_window_text(primary.as_ref());
    let secondary_text = codex_window_text(secondary.as_ref());
    let plan_text = account
        .account
        .as_ref()
        .and_then(|acct| acct.plan_type())
        .or(snapshot.plan_type.clone())
        .unwrap_or_else(|| "unknown".to_string());

    Ok(ProviderUsageSnapshot {
        provider: "codex".to_string(),
        status: "available".to_string(),
        summary: format!(
            "Session {}, Week {}",
            codex_window_percent(primary.as_ref()),
            codex_window_percent(secondary.as_ref())
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

async fn fetch_zai_snapshot(token: Option<String>) -> ProviderUsageSnapshot {
    let Some(token) = token else {
        return ProviderUsageSnapshot {
            provider: "zai".to_string(),
            status: "unavailable".to_string(),
            summary: "No z.ai token configured".to_string(),
            note: Some(
                "Add `Z_AI_API_KEY` in Usage settings, ClawTab Secrets, or your environment."
                    .to_string(),
            ),
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
    let (session_token, token_limit, time_limit) = categorize_zai_limits(&limits);
    let summary = zai_summary(session_token, token_limit, time_limit);

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
    if let Some(limit) = session_token {
        entries.push(UsageEntry {
            label: zai_limit_label(limit, "Session").to_string(),
            value: zai_limit_text(limit),
        });
    }
    if let Some(limit) = token_limit {
        entries.push(UsageEntry {
            label: zai_limit_label(limit, "Tokens").to_string(),
            value: zai_limit_text(limit),
        });
    }
    if let Some(limit) = time_limit {
        entries.push(UsageEntry {
            label: "MCP".to_string(),
            value: zai_limit_text(limit),
        });
    }
    for detail in data.usage_details.unwrap_or_default().into_iter().take(3) {
        let label = detail.model.clone().unwrap_or_else(|| "Model".to_string());
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

fn normalize_codex_windows(
    primary: Option<CodexRateLimitWindow>,
    secondary: Option<CodexRateLimitWindow>,
) -> (Option<CodexRateLimitWindow>, Option<CodexRateLimitWindow>) {
    match (primary, secondary) {
        (Some(primary), Some(secondary)) => {
            match (primary.window_role(), secondary.window_role()) {
                (CodexWindowRole::Session, CodexWindowRole::Week)
                | (CodexWindowRole::Session, CodexWindowRole::Unknown)
                | (CodexWindowRole::Unknown, CodexWindowRole::Week) => {
                    (Some(primary), Some(secondary))
                }
                (CodexWindowRole::Week, CodexWindowRole::Session)
                | (CodexWindowRole::Week, CodexWindowRole::Unknown) => {
                    (Some(secondary), Some(primary))
                }
                _ => (Some(primary), Some(secondary)),
            }
        }
        (Some(window), None) => match window.window_role() {
            CodexWindowRole::Week => (None, Some(window)),
            CodexWindowRole::Session | CodexWindowRole::Unknown => (Some(window), None),
        },
        (None, Some(window)) => match window.window_role() {
            CodexWindowRole::Session | CodexWindowRole::Unknown => (Some(window), None),
            CodexWindowRole::Week => (None, Some(window)),
        },
        (None, None) => (None, None),
    }
}

fn read_codex_status_cli_snapshot() -> Result<ProviderUsageSnapshot, String> {
    let output = run_codex_status_pty(Duration::from_secs(8))?;
    parse_codex_status_snapshot(&output)
}

fn resolve_codex_binary() -> PathBuf {
    let resolved = resolve_codex_binary_inner();
    #[cfg(target_os = "macos")]
    strip_quarantine(&resolved);
    resolved
}

fn resolve_codex_binary_inner() -> PathBuf {
    for var_name in ["CLAWTAB_CODEX_PATH", "CODEX_PATH", "CODEX_BINARY"] {
        if let Ok(value) = std::env::var(var_name) {
            let candidate = PathBuf::from(value);
            if is_executable_file(&candidate) {
                return candidate;
            }
        }
    }

    for candidate in [
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        "/usr/bin/codex",
    ] {
        let candidate = PathBuf::from(candidate);
        if is_executable_file(&candidate) {
            return candidate;
        }
    }

    if let Some(home) = dirs::home_dir() {
        for suffix in [
            ".local/bin/codex",
            ".npm-global/bin/codex",
            ".bun/bin/codex",
            ".yarn/bin/codex",
        ] {
            let candidate = home.join(suffix);
            if is_executable_file(&candidate) {
                return candidate;
            }
        }
    }

    PathBuf::from("codex")
}

#[cfg(target_os = "macos")]
fn strip_quarantine(path: &Path) {
    use std::sync::Mutex;
    use std::sync::OnceLock;

    static STRIPPED: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
    let stripped = STRIPPED.get_or_init(|| Mutex::new(Vec::new()));

    let canonical = match std::fs::canonicalize(path) {
        Ok(p) => p,
        Err(_) => return,
    };

    {
        let guard = stripped.lock().unwrap();
        if guard.iter().any(|p| p == &canonical) {
            return;
        }
    }

    let has_quarantine = Command::new("xattr")
        .arg(&canonical)
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.lines().any(|l| l.trim() == "com.apple.quarantine"))
        .unwrap_or(false);

    if has_quarantine {
        let _ = Command::new("xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(&canonical)
            .output();
    }

    stripped.lock().unwrap().push(canonical);
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn run_codex_status_pty(timeout: Duration) -> Result<String, String> {
    let codex_binary = resolve_codex_binary();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 70,
            cols: 220,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("openpty: {}", err))?;

    let mut cmd = CommandBuilder::new(codex_binary.to_string_lossy().to_string());
    cmd.args(["-s", "read-only", "-a", "untrusted"]);
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd).map_err(|err| {
        format!(
            "failed to start codex at {}: {}",
            codex_binary.display(),
            err
        )
    })?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("clone reader: {}", err))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("take writer: {}", err))?;

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buf = [0_u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let deadline = Instant::now() + timeout;
    let command_deadline = Instant::now() + Duration::from_millis(1200);
    let mut output = Vec::new();
    let mut command_sent = false;
    let mut status_seen_at: Option<Instant> = None;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(bytes) => {
                output.extend(bytes);
                let text = String::from_utf8_lossy(&output);
                if !command_sent && (Instant::now() >= command_deadline || codex_tui_ready(&text)) {
                    send_codex_status(&mut writer)?;
                    command_sent = true;
                }
                if text.contains("data not available yet") {
                    break;
                }
                if text.contains("Weekly limit") && status_seen_at.is_none() {
                    status_seen_at = Some(Instant::now());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !command_sent && Instant::now() >= command_deadline {
                    send_codex_status(&mut writer)?;
                    command_sent = true;
                }
                if status_seen_at
                    .map(|seen| seen.elapsed() >= Duration::from_millis(600))
                    .unwrap_or(false)
                {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = child.kill();
    let _ = child.wait();

    let text = strip_ansi_codes(&String::from_utf8_lossy(&output));
    if text.trim().is_empty() {
        Err("Codex status probe returned no output".to_string())
    } else {
        Ok(text)
    }
}

fn codex_tui_ready(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    text.contains('›') || text.contains('▌') || lower.contains("what would you like")
}

fn send_codex_status(writer: &mut dyn Write) -> Result<(), String> {
    writer
        .write_all(b"/status\r")
        .and_then(|_| writer.flush())
        .map_err(|err| format!("send /status: {}", err))
}

fn parse_codex_status_snapshot(text: &str) -> Result<ProviderUsageSnapshot, String> {
    if text.to_ascii_lowercase().contains("data not available yet") {
        return Err("Codex usage data is not available yet".to_string());
    }

    let lines = text.lines().collect::<Vec<_>>();
    let session = parse_codex_status_entry(&lines, "5h limit");
    let week = parse_codex_status_entry(&lines, "weekly limit");
    let plan = first_matching_line(text, "plan:")
        .and_then(|line| {
            line.split_once(':')
                .map(|(_, value)| value.trim().to_string())
        })
        .filter(|value| !value.is_empty());

    if session.is_none() && week.is_none() {
        return Err("Could not parse Codex session or weekly limits".to_string());
    }

    let mut entries = Vec::new();
    if let Some(plan) = plan {
        entries.push(UsageEntry {
            label: "Plan".to_string(),
            value: title_case_words(&plan),
        });
    }
    entries.push(UsageEntry {
        label: "Session".to_string(),
        value: session
            .as_ref()
            .map(CodexCliLimit::display_text)
            .unwrap_or_else(|| "n/a".to_string()),
    });
    entries.push(UsageEntry {
        label: "Week".to_string(),
        value: week
            .as_ref()
            .map(CodexCliLimit::display_text)
            .unwrap_or_else(|| "n/a".to_string()),
    });

    Ok(ProviderUsageSnapshot {
        provider: "codex".to_string(),
        status: "available".to_string(),
        summary: format!(
            "Session {}, Week {}",
            session
                .as_ref()
                .map(CodexCliLimit::summary_text)
                .unwrap_or_else(|| "n/a".to_string()),
            week.as_ref()
                .map(CodexCliLimit::summary_text)
                .unwrap_or_else(|| "n/a".to_string())
        ),
        note: None,
        entries,
    })
}

fn first_matching_line<'a>(text: &'a str, needle: &str) -> Option<&'a str> {
    let needle = needle.to_ascii_lowercase();
    text.lines()
        .find(|line| line.to_ascii_lowercase().contains(&needle))
}

fn parse_codex_status_entry(lines: &[&str], needle: &str) -> Option<CodexCliLimit> {
    let needle = needle.to_ascii_lowercase();
    let (index, line) = lines
        .iter()
        .enumerate()
        .find(|(_, line)| line.to_ascii_lowercase().contains(&needle))?;
    let mut combined = line.trim().to_string();
    for next in lines.iter().skip(index + 1).take(4) {
        let next = next.trim();
        if next.is_empty() {
            continue;
        }

        let next_lower = next.to_ascii_lowercase();
        if next_lower.contains("limit") {
            break;
        }

        let needs_percent = !combined.contains('%');
        let needs_reset = !combined.to_ascii_lowercase().contains("resets");
        if needs_percent
            || (needs_reset
                && (next_lower.contains("reset")
                    || next_lower.contains("left")
                    || next_lower.contains('%')))
        {
            combined.push(' ');
            combined.push_str(next);
        }

        if combined.contains('%') && combined.to_ascii_lowercase().contains("resets") {
            break;
        }
    }

    parse_codex_status_line(&combined)
}

fn parse_codex_status_line(line: &str) -> Option<CodexCliLimit> {
    let percent_left = first_percent_in(line)?;
    let reset = reset_text_from_line(line);
    Some(CodexCliLimit {
        percent_left,
        reset,
    })
}

fn first_percent_in(line: &str) -> Option<i64> {
    let percent_index = line.find('%')?;
    let before = &line[..percent_index];
    let start = before
        .char_indices()
        .rev()
        .find(|(_, ch)| !(ch.is_ascii_digit() || *ch == '.'))
        .map(|(index, ch)| index + ch.len_utf8())
        .unwrap_or(0);
    before[start..]
        .trim()
        .parse::<f64>()
        .ok()
        .map(|value| value.round() as i64)
}

fn reset_text_from_line(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let start = lower.find("resets")?;
    let mut text = line[start + "resets".len()..].trim().to_string();
    loop {
        let cleaned = text
            .trim()
            .trim_matches(|ch: char| {
                ch == '(' || ch == ')' || ch == ':' || ch == '-' || ch == '|' || ch == '│'
            })
            .trim()
            .to_string();
        if cleaned == text {
            break;
        }
        text = cleaned;
    }
    (!text.is_empty()).then(|| text.to_string())
}

fn strip_ansi_codes(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                let _ = chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else if !ch.is_control() || ch == '\n' || ch == '\t' {
            output.push(ch);
        }
    }
    output
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

fn opencode_auth_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".local/share/opencode/auth.json")
}

fn categorize_zai_limits(
    limits: &[ZaiLimit],
) -> (Option<&ZaiLimit>, Option<&ZaiLimit>, Option<&ZaiLimit>) {
    let mut token_limits = limits
        .iter()
        .filter(|limit| limit.is_token_limit())
        .collect::<Vec<_>>();
    token_limits.sort_by_key(|limit| limit.window_minutes().unwrap_or(i64::MAX));
    let time_limit = limits.iter().find(|limit| limit.is_time_limit());

    match token_limits.as_slice() {
        [] => (None, None, time_limit),
        [single] => (None, Some(*single), time_limit),
        many => (many.first().copied(), many.last().copied(), time_limit),
    }
}

fn zai_summary(
    session_token: Option<&ZaiLimit>,
    token_limit: Option<&ZaiLimit>,
    time_limit: Option<&ZaiLimit>,
) -> String {
    match (session_token, token_limit, time_limit) {
        (Some(session), Some(token), _) => format!(
            "Session {}, Week {}",
            zai_limit_percent(session),
            zai_limit_percent(token)
        ),
        (None, Some(token), Some(mcp)) => {
            format!(
                "Tokens {}, MCP {}",
                zai_limit_percent(token),
                zai_limit_percent(mcp)
            )
        }
        (None, Some(token), None) => format!("Tokens {}", zai_limit_percent(token)),
        (None, None, Some(mcp)) => format!("MCP {}", zai_limit_percent(mcp)),
        (None, None, None) => "Quota data available".to_string(),
        (Some(session), None, Some(mcp)) => {
            format!(
                "Session {}, MCP {}",
                zai_limit_percent(session),
                zai_limit_percent(mcp)
            )
        }
        (Some(session), None, None) => format!("Session {}", zai_limit_percent(session)),
    }
}

fn zai_limit_percent(limit: &ZaiLimit) -> String {
    limit
        .used_ratio_percent()
        .map(|value| format!("{}%", value))
        .unwrap_or_else(|| "n/a".to_string())
}

fn zai_limit_label<'a>(limit: &ZaiLimit, fallback: &'a str) -> String {
    match limit.window_minutes() {
        Some(300) => "Session".to_string(),
        Some(10080) => "Week".to_string(),
        _ => limit
            .window_description()
            .unwrap_or_else(|| fallback.to_string()),
    }
}

fn zai_limit_text(limit: &ZaiLimit) -> String {
    let percent = limit
        .used_ratio_percent()
        .map(|value| format!("{}% used", value));
    let usage = match (limit.used_value(), limit.total_value()) {
        (Some(used), Some(total)) => Some(format!(
            "{}/{}",
            format_numberish(used),
            format_numberish(total)
        )),
        (Some(used), None) => Some(format_numberish(used)),
        (None, Some(total)) => Some(format!("limit {}", format_numberish(total))),
        (None, None) => None,
    };
    let mut parts = Vec::new();
    if let Some(percent) = percent {
        parts.push(percent);
    }
    if let Some(usage) = usage {
        parts.push(usage);
    }
    if let Some(window) = limit.window_description() {
        parts.push(window);
    }
    let base = if parts.is_empty() {
        "Quota data available".to_string()
    } else {
        parts.join(", ")
    };
    match limit.next_reset_time.and_then(epoch_millis_to_human) {
        Some(reset) => format!("{} (resets {})", base, reset),
        None => base,
    }
}

fn epoch_millis_to_human(epoch_millis: i64) -> Option<String> {
    let millis = if epoch_millis < 100_000_000_000 {
        epoch_millis * 1000
    } else {
        epoch_millis
    };
    Utc.timestamp_millis_opt(millis)
        .single()
        .map(relative_time_from)
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

#[derive(Debug)]
struct CodexCliLimit {
    percent_left: i64,
    reset: Option<String>,
}

impl CodexCliLimit {
    fn summary_text(&self) -> String {
        format!("{}% left", self.percent_left)
    }

    fn display_text(&self) -> String {
        match &self.reset {
            Some(reset) => format!("{}% left (resets {})", self.percent_left, reset),
            None => format!("{}% left", self.percent_left),
        }
    }
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
    plan_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexRateLimitWindow {
    used_percent: i64,
    resets_at: Option<i64>,
    limit_window_seconds: Option<i64>,
}

enum CodexWindowRole {
    Session,
    Week,
    Unknown,
}

impl CodexRateLimitWindow {
    fn window_role(&self) -> CodexWindowRole {
        match self.limit_window_seconds.map(|seconds| seconds / 60) {
            Some(300) => CodexWindowRole::Session,
            Some(10080) => CodexWindowRole::Week,
            _ => CodexWindowRole::Unknown,
        }
    }
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
    #[serde(alias = "type", alias = "limit_type")]
    limit_type: Option<String>,
    unit: Option<i64>,
    number: Option<i64>,
    usage: Option<f64>,
    current_value: Option<f64>,
    remaining: Option<f64>,
    percentage: Option<f64>,
    used: Option<f64>,
    limit: Option<f64>,
    next_reset_time: Option<i64>,
}

impl ZaiLimit {
    fn used_ratio_percent(&self) -> Option<i64> {
        if let Some(percentage) = self.percentage {
            return Some(percentage.round() as i64);
        }

        match (self.used_value(), self.total_value()) {
            (Some(used), Some(limit)) if limit > 0.0 => {
                Some(((used / limit) * 100.0).round() as i64)
            }
            _ => None,
        }
    }

    fn total_value(&self) -> Option<f64> {
        self.limit.or(self.usage)
    }

    fn used_value(&self) -> Option<f64> {
        self.used.or(self.current_value).or_else(|| {
            let total = self.total_value()?;
            let remaining = self.remaining?;
            Some((total - remaining).max(0.0))
        })
    }

    fn window_minutes(&self) -> Option<i64> {
        let number = self.number?;
        if number <= 0 {
            return None;
        }
        match self.unit {
            Some(5) => Some(number),
            Some(3) => Some(number * 60),
            Some(1) => Some(number * 24 * 60),
            Some(6) => Some(number * 7 * 24 * 60),
            _ => None,
        }
    }

    fn window_description(&self) -> Option<String> {
        let number = self.number?;
        if number <= 0 {
            return None;
        }
        let unit = match self.unit {
            Some(5) => "minute",
            Some(3) => "hour",
            Some(1) => "day",
            Some(6) => "week",
            _ => return None,
        };
        let suffix = if number == 1 {
            unit.to_string()
        } else {
            format!("{}s", unit)
        };
        Some(format!("{} {}", number, suffix))
    }

    fn is_token_limit(&self) -> bool {
        self.limit_type.as_deref() == Some("TOKENS_LIMIT")
    }

    fn is_time_limit(&self) -> bool {
        self.limit_type.as_deref() == Some("TIME_LIMIT")
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
            (Some(used), Some(limit)) => {
                format!("{}/{}", format_numberish(used), format_numberish(limit))
            }
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

pub const ZAI_TOKEN_KEYS: &[&str] = &["Z_AI_API_KEY", "ZAI_API_KEY", "Z_AI_TOKEN", "ZAI_TOKEN"];

pub fn resolve_zai_token_from_sources(explicit_tokens: Vec<Option<String>>) -> Option<String> {
    explicit_tokens
        .into_iter()
        .flatten()
        .map(|token| token.trim().to_string())
        .find(|token| !token.is_empty())
        .or_else(read_zai_token_from_opencode)
        .or_else(read_zai_token_from_env)
}

fn read_zai_token_from_env() -> Option<String> {
    ZAI_TOKEN_KEYS.iter().find_map(|key| {
        std::env::var(key)
            .ok()
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
    })
}

fn read_zai_token_from_opencode() -> Option<String> {
    let path = opencode_auth_path();
    let contents = std::fs::read_to_string(path).ok()?;
    let auth = serde_json::from_str::<OpenCodeAuthFile>(&contents).ok()?;
    auth.zai_coding_plan
        .map(|entry| entry.key)
        .or_else(|| auth.zai.map(|entry| entry.key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_week_limit_when_status_wraps() {
        let snapshot = parse_codex_status_snapshot(
            r#"
Account: user@example.com (Plus)
5h limit: 38% left (resets 11:38)
Weekly limit:
  49% left
  (resets 06:14 on 17 Apr) │)
"#,
        )
        .expect("status should parse");

        let week = snapshot
            .entries
            .iter()
            .find(|entry| entry.label == "Week")
            .expect("week entry");
        assert_eq!(week.value, "49% left (resets 06:14 on 17 Apr)");
        assert_eq!(snapshot.summary, "Session 38% left, Week 49% left");
    }
}
