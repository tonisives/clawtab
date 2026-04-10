mod claude;
mod codex;
mod common;
mod opencode;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Default)]
pub struct SessionInfo {
    pub first_query: Option<String>,
    pub last_query: Option<String>,
    pub session_started_at: Option<String>,
    pub started_epoch: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessProvider {
    Claude,
    Codex,
    Opencode,
    Shell,
}

impl ProcessProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            ProcessProvider::Claude => "claude",
            ProcessProvider::Codex => "codex",
            ProcessProvider::Opencode => "opencode",
            ProcessProvider::Shell => "shell",
        }
    }

    pub fn binary_name(self) -> &'static str {
        self.as_str()
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProcessSnapshot {
    commands: HashMap<String, String>,
    children: HashMap<String, Vec<String>>,
    start_epoch: HashMap<String, i64>,
}

impl ProcessSnapshot {
    pub fn capture() -> Self {
        let output = match Command::new("ps")
            .args(["-Ao", "pid=,ppid=,lstart=,command="])
            .output()
        {
            Ok(o) if o.status.success() => o,
            _ => return Self::default(),
        };

        let mut snapshot = Self::default();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let mut parts = line.split_whitespace();
            let pid = match parts.next() {
                Some(pid) => pid,
                None => continue,
            };
            let ppid = match parts.next() {
                Some(ppid) => ppid,
                None => continue,
            };
            // lstart= emits exactly 5 fixed tokens: "Day Mon DoM HH:MM:SS Year"
            let lstart_tokens: Vec<&str> = (0..5).filter_map(|_| parts.next()).collect();
            if lstart_tokens.len() < 5 {
                continue;
            }
            let lstart_str = lstart_tokens.join(" ");
            let command = parts.collect::<Vec<_>>().join(" ");
            if command.is_empty() {
                continue;
            }
            snapshot.commands.insert(pid.to_string(), command);
            snapshot
                .children
                .entry(ppid.to_string())
                .or_default()
                .push(pid.to_string());
            if let Some(epoch) = parse_lstart(&lstart_str) {
                snapshot.start_epoch.insert(pid.to_string(), epoch);
            }
        }
        snapshot
    }

    pub fn command_for_pid(&self, pid: &str) -> Option<&str> {
        self.commands.get(pid).map(String::as_str)
    }

    pub fn child_pids(&self, pid: &str) -> &[String] {
        self.children.get(pid).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn start_epoch_for_pid(&self, pid: &str) -> Option<i64> {
        self.start_epoch.get(pid).copied()
    }
}

fn parse_lstart(s: &str) -> Option<i64> {
    use chrono::{NaiveDateTime, TimeZone};
    let naive = NaiveDateTime::parse_from_str(s, "%a %b %e %H:%M:%S %Y").ok()?;
    chrono::Local.from_local_datetime(&naive).single().map(|dt| dt.timestamp())
}

/// Resolve session info for an agent pane.
pub fn resolve_session_info(pane_pid: &str) -> SessionInfo {
    resolve_session_info_with_snapshot(pane_pid, None)
}

pub fn resolve_session_info_with_snapshot(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    let provider = detect_process_provider(pane_pid, snapshot);
    resolve_session_info_for_provider(pane_pid, provider, snapshot)
}

pub fn resolve_session_info_for_provider(
    pane_pid: &str,
    provider: Option<ProcessProvider>,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    resolve_session_info_for_provider_with_cwd(pane_pid, provider, snapshot, None)
}

pub fn resolve_session_info_for_provider_with_cwd(
    pane_pid: &str,
    provider: Option<ProcessProvider>,
    snapshot: Option<&ProcessSnapshot>,
    cwd: Option<&str>,
) -> SessionInfo {
    match provider {
        Some(ProcessProvider::Claude) => claude::resolve_session_info(pane_pid, snapshot),
        Some(ProcessProvider::Codex) => codex::resolve_session_info(pane_pid, snapshot),
        Some(ProcessProvider::Opencode) => opencode::resolve_session_info(pane_pid, snapshot, cwd),
        Some(ProcessProvider::Shell) | None => SessionInfo::default(),
    }
}

pub fn detect_process_provider(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> Option<ProcessProvider> {
    let owned_snapshot;
    let snapshot = match snapshot {
        Some(snapshot) => snapshot,
        None => {
            owned_snapshot = ProcessSnapshot::capture();
            &owned_snapshot
        }
    };

    if let Some(provider) = provider_for_command(snapshot.command_for_pid(pane_pid)) {
        return Some(provider);
    }

    for child in snapshot.child_pids(pane_pid) {
        if let Some(provider) = provider_for_command(snapshot.command_for_pid(child)) {
            return Some(provider);
        }

        for grandchild in snapshot.child_pids(child) {
            if let Some(provider) = provider_for_command(snapshot.command_for_pid(grandchild)) {
                return Some(provider);
            }
        }
    }

    None
}

pub fn detect_version_from_command(command: &str) -> Option<String> {
    let mut token = String::new();
    let mut found = Vec::new();

    for ch in command.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            token.push(ch);
        } else if !token.is_empty() {
            found.push(token.clone());
            token.clear();
        }
    }
    if !token.is_empty() {
        found.push(token);
    }

    found.into_iter().find(|item| common::is_semver(item))
}

fn provider_for_command(command: Option<&str>) -> Option<ProcessProvider> {
    let lower = command?.to_ascii_lowercase();
    if lower.contains("codex") {
        Some(ProcessProvider::Codex)
    } else if lower.contains("opencode") {
        Some(ProcessProvider::Opencode)
    } else if lower.contains("claude") && !lower.contains("claude.app") {
        Some(ProcessProvider::Claude)
    } else {
        None
    }
}
