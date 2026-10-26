mod antigravity;
mod claude;
mod codex;
mod common;
pub(crate) mod hermes;
mod opencode;

pub(crate) use codex::completed_turn_after as codex_completed_turn_after;
pub(crate) use codex::session_activity_for_pane as codex_session_activity_for_pane;
pub(crate) use codex::thread_id_for_pane as codex_thread_id_for_pane;

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::process::Command;

#[derive(Default)]
pub(crate) struct SessionActivity {
    pub last_action_at_ms: Option<u64>,
    pub file_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SessionInfo {
    pub restore_command: Option<String>,
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub model_id: Option<String>,
    pub agent_effort: Option<String>,
    pub first_query: Option<String>,
    pub last_query: Option<String>,
    pub last_user_message_at: Option<i64>,
    pub session_started_at: Option<String>,
    pub started_epoch: Option<u64>,
    pub token_count: Option<u64>,
    pub session_file_size_bytes: Option<u64>,
}

pub fn session_file_size_alert(size: Option<u64>, threshold_mb: u64) -> Option<String> {
    let size = size?;
    if threshold_mb == 0 || size < threshold_mb.saturating_mul(1_000_000) {
        return None;
    }
    Some(format!(
        "Codex session file is {} MB (warning at {} MB). Start a new session; compacting does not shrink the file.",
        size / 1_000_000, threshold_mb
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessProvider {
    Claude,
    Codex,
    Opencode,
    Antigravity,
    Hermes,
    Shell,
}

impl ProcessProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            ProcessProvider::Claude => "claude",
            ProcessProvider::Codex => "codex",
            ProcessProvider::Opencode => "opencode",
            ProcessProvider::Antigravity => "antigravity",
            ProcessProvider::Hermes => "hermes",
            ProcessProvider::Shell => "shell",
        }
    }

    pub fn binary_name(self) -> &'static str {
        match self {
            ProcessProvider::Antigravity => "agy",
            _ => self.as_str(),
        }
    }

    pub fn from_name(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::Opencode),
            "antigravity" => Some(Self::Antigravity),
            "hermes" => Some(Self::Hermes),
            "shell" => Some(Self::Shell),
            _ => None,
        }
    }

    pub fn supports_model_flag(self) -> bool {
        matches!(
            self,
            ProcessProvider::Claude
                | ProcessProvider::Codex
                | ProcessProvider::Opencode
                | ProcessProvider::Antigravity
                | ProcessProvider::Hermes
        )
    }

    /// Returns the CLI flag format for passing a model to this provider.
    pub fn model_flag_format(self, model: &str) -> String {
        match self {
            ProcessProvider::Opencode => format!(" -m {}", shell_quote(model)),
            _ => format!(" --model {}", shell_quote(model)),
        }
    }

    pub fn effort_flag_format(self, effort: &str) -> String {
        match self {
            ProcessProvider::Claude => format!(" --effort {}", shell_quote(effort)),
            ProcessProvider::Hermes => format!(" --reasoning {}", shell_quote(effort)),
            ProcessProvider::Codex => format!(
                " -c {}",
                shell_quote(&format!("model_reasoning_effort={}", effort))
            ),
            _ => String::new(),
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[derive(Debug, Clone, Default)]
pub struct ProcessSnapshot {
    commands: HashMap<String, String>,
    children: HashMap<String, Vec<String>>,
    start_epoch: HashMap<String, i64>,
    managed: HashMap<String, crate::managed::Launch>,
}

impl ProcessSnapshot {
    fn add_managed(&mut self) {
        for info in crate::managed::list()
            .unwrap_or_default()
            .into_iter()
            .filter(|info| info.status == crate::managed::Status::Running)
        {
            let pid = info.child_pid.to_string();
            self.commands.insert(
                pid.clone(),
                std::iter::once(info.launch.program.as_str())
                    .chain(info.launch.args.iter().map(String::as_str))
                    .map(shell_quote)
                    .collect::<Vec<_>>()
                    .join(" "),
            );
            self.start_epoch.insert(pid.clone(), info.started_at as i64);
            self.managed.insert(pid, info.launch);
        }
    }
    #[cfg(windows)]
    pub fn capture() -> Self {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
        };
        let mut snapshot = Self::default();
        let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if handle != INVALID_HANDLE_VALUE {
            let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut found = unsafe { Process32FirstW(handle, &mut entry) } != 0;
            while found {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                snapshot.commands.insert(
                    entry.th32ProcessID.to_string(),
                    String::from_utf16_lossy(&entry.szExeFile[..end]),
                );
                snapshot
                    .children
                    .entry(entry.th32ParentProcessID.to_string())
                    .or_default()
                    .push(entry.th32ProcessID.to_string());
                found = unsafe { Process32NextW(handle, &mut entry) } != 0;
            }
            unsafe {
                CloseHandle(handle);
            }
        }
        snapshot.add_managed();
        snapshot
    }
    #[cfg(unix)]
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
        snapshot.add_managed();
        snapshot
    }

    pub fn command_for_pid(&self, pid: &str) -> Option<&str> {
        self.commands.get(pid).map(String::as_str)
    }

    pub fn child_pids(&self, pid: &str) -> &[String] {
        self.children.get(pid).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn process_tree_pids(&self, root_pid: &str) -> HashSet<String> {
        let mut process_ids = HashSet::from([root_pid.to_string()]);
        let mut pending = vec![root_pid];

        while let Some(pid) = pending.pop() {
            for child in self.child_pids(pid) {
                if process_ids.insert(child.clone()) {
                    pending.push(child);
                }
            }
        }

        process_ids
    }

    pub fn start_epoch_for_pid(&self, pid: &str) -> Option<i64> {
        self.start_epoch.get(pid).copied()
    }
}

fn parse_lstart(s: &str) -> Option<i64> {
    use chrono::{NaiveDateTime, TimeZone};
    let naive = NaiveDateTime::parse_from_str(s, "%a %b %e %H:%M:%S %Y").ok()?;
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .map(|dt| dt.timestamp())
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
    resolve_session_info_for_provider_with_cwd_mode(pane_pid, provider, snapshot, cwd, true)
}

/// Resolve only the session identity and prompt metadata needed by lightweight
/// clients such as the tmux modal. Provider-specific rollout details can be
/// much larger than the session fields and are intentionally skipped here.
pub fn resolve_session_info_for_provider_with_cwd_fast(
    pane_pid: &str,
    provider: Option<ProcessProvider>,
    snapshot: Option<&ProcessSnapshot>,
    cwd: Option<&str>,
) -> SessionInfo {
    resolve_session_info_for_provider_with_cwd_mode(pane_pid, provider, snapshot, cwd, false)
}

/// Resolve the session identity needed by pane lists.
pub fn resolve_session_identity(
    pane_pid: &str,
    provider: ProcessProvider,
    snapshot: &ProcessSnapshot,
    cwd: Option<&str>,
) -> Option<String> {
    let identity = match provider {
        ProcessProvider::Codex => codex::thread_id_for_pane(pane_pid, Some(snapshot)),
        ProcessProvider::Claude => claude::session_id(pane_pid, Some(snapshot)),
        ProcessProvider::Hermes => {
            hermes::identity_for_pane(pane_pid, Some(snapshot)).map(|identity| identity.session_id)
        }
        ProcessProvider::Shell => None,
        _ => {
            resolve_session_info_for_provider_with_cwd_fast(
                pane_pid,
                Some(provider),
                Some(snapshot),
                cwd,
            )
            .session_id
        }
    };
    identity.or_else(|| snapshot.managed.get(pane_pid)?.conversation_id.clone())
}

fn resolve_session_info_for_provider_with_cwd_mode(
    pane_pid: &str,
    provider: Option<ProcessProvider>,
    snapshot: Option<&ProcessSnapshot>,
    cwd: Option<&str>,
    include_details: bool,
) -> SessionInfo {
    let mut info = match provider {
        Some(ProcessProvider::Claude) => claude::resolve_session_info(pane_pid, snapshot),
        Some(ProcessProvider::Codex) => {
            if include_details {
                codex::resolve_session_info(pane_pid, snapshot)
            } else {
                codex::resolve_session_info_fast(pane_pid, snapshot)
            }
        }
        Some(ProcessProvider::Opencode) => opencode::resolve_session_info(pane_pid, snapshot, cwd),
        Some(ProcessProvider::Antigravity) => antigravity::resolve_session_info(pane_pid, snapshot),
        Some(ProcessProvider::Hermes) => hermes::resolve_session_info(pane_pid, snapshot),
        Some(ProcessProvider::Shell) | None => SessionInfo::default(),
    };
    if info.session_id.is_none() {
        info.session_id = snapshot
            .and_then(|snapshot| snapshot.managed.get(pane_pid))
            .and_then(|launch| launch.conversation_id.clone());
    }
    if include_details {
        if info.model_id.is_none() {
            info.model_id = provider
                .and_then(|provider| detect_model_from_process_tree(pane_pid, provider, snapshot));
        }
        if info.agent_effort.is_none() {
            info.agent_effort = provider
                .and_then(|provider| detect_effort_from_process_tree(pane_pid, provider, snapshot));
        }
    }
    info
}

fn detect_model_from_process_tree(
    pane_pid: &str,
    provider: ProcessProvider,
    snapshot: Option<&ProcessSnapshot>,
) -> Option<String> {
    let snapshot = snapshot?;
    let mut pids = vec![pane_pid];
    pids.extend(snapshot.child_pids(pane_pid).iter().map(String::as_str));
    for child in snapshot.child_pids(pane_pid) {
        pids.extend(snapshot.child_pids(child).iter().map(String::as_str));
    }
    pids.into_iter().find_map(|pid| {
        let command = snapshot.command_for_pid(pid)?;
        if provider_for_command(Some(command)) != Some(provider) {
            return None;
        }
        model_from_command(command)
    })
}

fn model_from_command(command: &str) -> Option<String> {
    let parts = command.split_whitespace().collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        if let Some(model) = part.strip_prefix("--model=") {
            return (!model.is_empty()).then(|| model.trim_matches(['\'', '"']).to_string());
        }
        if (*part == "--model" || *part == "-m") && index + 1 < parts.len() {
            let model = parts[index + 1].trim_matches(['\'', '"']);
            return (!model.is_empty()).then(|| model.to_string());
        }
    }
    None
}

fn detect_effort_from_process_tree(
    pane_pid: &str,
    provider: ProcessProvider,
    snapshot: Option<&ProcessSnapshot>,
) -> Option<String> {
    let snapshot = snapshot?;
    let mut pids = vec![pane_pid];
    pids.extend(snapshot.child_pids(pane_pid).iter().map(String::as_str));
    for child in snapshot.child_pids(pane_pid) {
        pids.extend(snapshot.child_pids(child).iter().map(String::as_str));
    }
    pids.into_iter().find_map(|pid| {
        let command = snapshot.command_for_pid(pid)?;
        if provider_for_command(Some(command)) != Some(provider) {
            return None;
        }
        effort_from_command(command)
    })
}

fn effort_from_command(command: &str) -> Option<String> {
    let parts = command.split_whitespace().collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        if let Some(effort) = part.strip_prefix("model_reasoning_effort=") {
            return valid_effort(effort.trim_matches(['\'', '"']));
        }
        if (*part == "--effort" || *part == "--reasoning" || *part == "-c")
            && index + 1 < parts.len()
        {
            let value = parts[index + 1].trim_matches(['\'', '"']);
            let effort = value
                .strip_prefix("model_reasoning_effort=")
                .unwrap_or(value);
            if let Some(effort) = valid_effort(effort) {
                return Some(effort);
            }
        }
    }
    None
}

fn valid_effort(value: &str) -> Option<String> {
    matches!(value, "low" | "medium" | "high" | "xhigh" | "max").then(|| value.to_string())
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

    if let Some(provider) = snapshot
        .managed
        .get(pane_pid)
        .and_then(|launch| ProcessProvider::from_name(&launch.provider))
        .filter(|provider| *provider != ProcessProvider::Shell)
    {
        return Some(provider);
    }
    if let Some(provider) = provider_for_pid(snapshot, pane_pid) {
        return Some(provider);
    }

    for child in snapshot.child_pids(pane_pid) {
        if let Some(provider) = provider_for_pid(snapshot, child) {
            return Some(provider);
        }

        for grandchild in snapshot.child_pids(child) {
            if let Some(provider) = provider_for_pid(snapshot, grandchild) {
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

/// The provider process inside a terminal's shell, used to bind local actions.
pub fn provider_process_pid(root: &str, snapshot: &ProcessSnapshot) -> Option<String> {
    let provider = detect_process_provider(root, Some(snapshot))?;
    if snapshot
        .managed
        .get(root)
        .and_then(|launch| ProcessProvider::from_name(&launch.provider))
        .is_some_and(|provider| provider != ProcessProvider::Shell)
    {
        return Some(root.into());
    }
    std::iter::once(root.to_string())
        .chain(snapshot.child_pids(root).iter().flat_map(|pid| {
            std::iter::once(pid.clone()).chain(snapshot.child_pids(pid).iter().cloned())
        }))
        .find(|pid| provider_for_pid(snapshot, pid) == Some(provider))
}

fn provider_for_pid(snapshot: &ProcessSnapshot, pid: &str) -> Option<ProcessProvider> {
    let command = snapshot.command_for_pid(pid)?;
    if let Some(interactive) = hermes::kind_for_pid(pid, command) {
        return interactive.then_some(ProcessProvider::Hermes);
    }
    provider_for_command(Some(command))
}

fn provider_for_command(command: Option<&str>) -> Option<ProcessProvider> {
    if let Some(interactive) = hermes::command_kind(command?) {
        return interactive.then_some(ProcessProvider::Hermes);
    }
    // Inspect the actual child of a shell launcher. Its command text can contain
    // model names such as "claude" or "codex" even when it is launching Hermes.
    let executable = command?
        .split_whitespace()
        .next()?
        .trim_matches(['\'', '"'])
        .rsplit('/')
        .next()?;
    if matches!(executable, "sh" | "bash" | "zsh" | "fish" | "dash" | "env") {
        return None;
    }
    let lower = command?.to_ascii_lowercase();
    if lower.contains("codex") {
        Some(ProcessProvider::Codex)
    } else if lower.contains("opencode") {
        Some(ProcessProvider::Opencode)
    } else if lower.contains("agy") || lower.contains("antigravity") {
        Some(ProcessProvider::Antigravity)
    } else if lower.contains("claude") && !lower.contains("claude.app") {
        Some(ProcessProvider::Claude)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{ProcessProvider, ProcessSnapshot};

    #[test]
    fn hermes_shell_launcher_is_not_the_provider_named_in_its_model() {
        let mut snapshot = ProcessSnapshot::default();
        snapshot.commands.insert(
            "1".into(),
            "zsh -c hermes chat --model anthropic/claude-sonnet".into(),
        );
        snapshot.commands.insert(
            "2".into(),
            "python /venv/bin/hermes chat --model anthropic/claude-sonnet".into(),
        );
        snapshot.children.insert("1".into(), vec!["2".into()]);
        assert_eq!(
            super::detect_process_provider("1", Some(&snapshot)),
            Some(ProcessProvider::Hermes)
        );
    }

    #[test]
    fn session_size_warnings_follow_the_configured_threshold() {
        assert_eq!(super::session_file_size_alert(None, 200), None);
        assert_eq!(super::session_file_size_alert(Some(1_200_000_000), 0), None);
        assert_eq!(super::session_file_size_alert(Some(199_999_999), 200), None);
        assert!(super::session_file_size_alert(Some(200_000_000), 200)
            .unwrap()
            .contains("200 MB"));
        assert!(super::session_file_size_alert(Some(1_200_000_000), 500)
            .unwrap()
            .contains("1200 MB (warning at 500 MB)"));
        assert_eq!(
            super::session_file_size_alert(Some(1_200_000_000), 1500),
            None
        );
    }

    #[test]
    fn old_settings_enable_size_warnings_by_default() {
        let settings: crate::config::settings::AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.session_file_warning_mb, 200);
        let settings: crate::config::settings::AppSettings =
            serde_json::from_str(r#"{"session_file_warning_mb":0}"#).unwrap();
        assert_eq!(settings.session_file_warning_mb, 0);
    }

    #[test]
    fn model_flags_preserve_a_single_literal_shell_argument() {
        let model = "provider/model with 'quotes' $(printf expanded)";
        for provider in [
            ProcessProvider::Claude,
            ProcessProvider::Codex,
            ProcessProvider::Opencode,
            ProcessProvider::Antigravity,
        ] {
            let script = format!(
                "set -- {}; printf '%s\\n' \"$#\" \"$1\" \"$2\"",
                provider.model_flag_format(model)
            );
            let output = std::process::Command::new("sh")
                .args(["-c", &script])
                .output()
                .unwrap();
            assert!(output.status.success());
            let flag = if provider == ProcessProvider::Opencode {
                "-m"
            } else {
                "--model"
            };
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("2\n{flag}\n{model}\n")
            );
        }
    }

    #[test]
    fn process_tree_pids_include_all_descendants() {
        let mut snapshot = ProcessSnapshot::default();
        snapshot
            .children
            .insert("10".to_string(), vec!["11".to_string()]);
        snapshot
            .children
            .insert("11".to_string(), vec!["12".to_string()]);
        snapshot
            .children
            .insert("12".to_string(), vec!["13".to_string()]);

        let process_ids = snapshot.process_tree_pids("10");

        assert_eq!(process_ids.len(), 4);
        assert!(process_ids.contains("10"));
        assert!(process_ids.contains("13"));
    }
}
