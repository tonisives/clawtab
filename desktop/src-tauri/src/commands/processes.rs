use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tauri::State;

use crate::agent_session::{detect_process_provider, detect_version_from_command, ProcessProvider};
use crate::config::jobs::JobStatus;
use crate::debug_spawn;
use crate::AppState;

#[derive(Debug, Clone)]
struct PaneJobMatch {
    group: String,
    slug: String,
    root: Option<String>,
    started_at: String,
}

pub use crate::config::settings::DetectedProcessOverride;

#[derive(Debug, Clone, Serialize)]
pub struct DetectedProcess {
    pub pane_id: String,
    pub cwd: String,
    pub version: String,
    pub display_name: Option<String>,
    pub pane_title: Option<String>,
    pub provider: String,
    pub can_fork_session: bool,
    pub can_send_skills: bool,
    pub can_inject_secrets: bool,
    pub tmux_session: String,
    pub window_name: String,
    pub matched_group: Option<String>,
    pub matched_job: Option<String>,
    pub log_lines: String,
    pub first_query: Option<String>,
    pub last_query: Option<String>,
    pub session_started_at: Option<String>,
    pub token_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExistingPaneInfo {
    pub pane_id: String,
    pub cwd: String,
    pub tmux_session: String,
    pub window_name: String,
    pub pane_title: Option<String>,
}

struct DetectionSnapshot {
    processes: Vec<DetectedProcess>,
}

fn is_view_session(name: &str) -> bool {
    name.starts_with("clawtab-") && name.contains("-view-")
}

fn resolve_non_view_session_for_window(window_id: &str, fallback: &str) -> String {
    let output = debug_spawn::run_logged(
        "tmux",
        &["list-windows", "-a", "-F", "#{session_name}\t#{window_id}"],
        "processes::resolve_non_view_session_for_window",
    );
    let Ok(output) = output else {
        return fallback.to_string();
    };
    if !output.status.success() {
        return fallback.to_string();
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let mut parts = line.splitn(2, '\t');
        let session = parts.next().unwrap_or("");
        let current_window_id = parts.next().unwrap_or("");
        if current_window_id == window_id && !is_view_session(session) {
            return session.to_string();
        }
    }

    fallback.to_string()
}

fn is_semver(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    parts
        .iter()
        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// Window in which a historical run's pane_id is still considered to refer
/// to the same logical pane. Older than this, we assume tmux recycled the
/// pane ID to a new unrelated session.
const HISTORY_PANE_TRUST_HOURS: i64 = 12;

fn is_recent_history(started_at: &str) -> bool {
    match chrono::DateTime::parse_from_rfc3339(started_at) {
        Ok(ts) => {
            let age = chrono::Utc::now().signed_duration_since(ts.with_timezone(&chrono::Utc));
            age < chrono::Duration::hours(HISTORY_PANE_TRUST_HOURS)
        }
        Err(_) => false,
    }
}

fn provider_capabilities(provider: ProcessProvider) -> (bool, bool, bool) {
    match provider {
        ProcessProvider::Claude => (true, true, true),
        ProcessProvider::Codex => (false, false, false),
        ProcessProvider::Opencode => (false, false, false),
        ProcessProvider::Shell => (false, false, false),
    }
}

#[tauri::command]
pub async fn detect_processes(state: State<'_, AppState>) -> Result<Vec<DetectedProcess>, String> {
    // Snapshot shared state under the lock, then release before spawning blocking work
    let live_viewer_panes: HashSet<String> =
        { state.pty_manager.lock().unwrap().active_pane_ids() };

    let match_entries: Vec<(String, String, String)> = {
        let config = state.jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .filter_map(|job| {
                if let Some(ref fp) = job.folder_path {
                    let root = fp.as_str();
                    Some((root.to_string(), job.group.clone(), job.slug.clone()))
                } else if let Some(ref wd) = job.work_dir {
                    Some((wd.clone(), job.group.clone(), job.slug.clone()))
                } else {
                    None
                }
            })
            .collect()
    };

    // Slug -> group lookup, so a pane_title tagged with a job slug can be
    // resolved to (group, slug) directly without depending on job_status or
    // the history trust window.
    let slug_to_group: HashMap<String, String> = {
        let config = state.jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .map(|job| (job.slug.clone(), job.group.clone()))
            .collect()
    };

    let history_panes: HashMap<String, PaneJobMatch> = {
        #[derive(Clone)]
        struct JobInfo {
            group: String,
            root: Option<String>,
        }
        let jobs_by_slug: HashMap<String, JobInfo> = {
            let config = state.jobs_config.lock().unwrap();
            config
                .jobs
                .iter()
                .map(|job| {
                    (
                        job.slug.clone(),
                        JobInfo {
                            group: job.group.clone(),
                            root: job.folder_path.clone().or_else(|| job.work_dir.clone()),
                        },
                    )
                })
                .collect()
        };
        let recent = state
            .history
            .lock()
            .unwrap()
            .get_recent(500)
            .unwrap_or_default();
        let mut panes = HashMap::new();
        for run in recent {
            let Some(pane_id) = run.pane_id else {
                continue;
            };
            if panes.contains_key(&pane_id) {
                continue;
            }
            if let Some(info) = jobs_by_slug.get(&run.job_id) {
                panes.insert(
                    pane_id,
                    PaneJobMatch {
                        group: info.group.clone(),
                        slug: run.job_id.clone(),
                        root: info.root.clone(),
                        started_at: run.started_at.clone(),
                    },
                );
            }
        }
        panes
    };

    let statuses: HashMap<String, JobStatus> =
        match crate::ipc::send_command(crate::ipc::IpcCommand::GetStatus).await {
            Ok(crate::ipc::IpcResponse::Status(s)) => s,
            _ => HashMap::new(),
        };
    let running_panes: HashMap<String, (String, String)> = {
        let config = state.jobs_config.lock().unwrap();
        statuses
            .iter()
            .filter_map(|(slug, status)| match status {
                JobStatus::Running {
                    pane_id: Some(pid), ..
                } => config
                    .jobs
                    .iter()
                    .find(|job| job.slug == *slug)
                    .map(|job| (pid.clone(), (job.group.clone(), job.slug.clone()))),
                _ => None,
            })
            .collect()
    };

    let overrides = state.process_overrides.lock().unwrap().clone();

    // Run all subprocess-heavy work off the async runtime
    let snapshot = tokio::task::spawn_blocking(move || {
        detect_processes_blocking(
            live_viewer_panes,
            match_entries,
            running_panes,
            history_panes,
            slug_to_group,
            overrides,
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))??;

    let detected_pane_ids: HashSet<String> = snapshot
        .processes
        .iter()
        .map(|p| p.pane_id.clone())
        .collect();
    prune_stale_process_overrides(&state, &detected_pane_ids)?;

    Ok(snapshot.processes)
}

fn detect_processes_blocking(
    live_viewer_panes: HashSet<String>,
    match_entries: Vec<(String, String, String)>,
    running_panes: HashMap<String, (String, String)>,
    history_panes: HashMap<String, PaneJobMatch>,
    slug_to_group: HashMap<String, String>,
    overrides: HashMap<String, DetectedProcessOverride>,
) -> Result<DetectionSnapshot, String> {
    let process_snapshot = crate::agent_session::ProcessSnapshot::capture();

    let output = debug_spawn::run_logged(
        "tmux",
        &[
            "list-panes",
            "-a",
            "-F",
            "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}\t#{window_name}\t#{pane_pid}\t#{window_id}\t#{pane_title}\t#{@clawtab-slug}",
        ],
        "processes::detect_processes::list-panes",
    );

    let output = match output {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            if stderr.contains("no server running") || stderr.contains("no sessions") {
                return Ok(DetectionSnapshot {
                    processes: Vec::new(),
                });
            }
            return Err(format!("tmux error: {}", stderr.trim()));
        }
        Err(e) => return Err(format!("Failed to run tmux: {}", e)),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut seen_panes = HashSet::new();
    let mut results = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(9, '\t').collect();
        if parts.len() < 8 {
            continue;
        }

        let pane_id = parts[0];
        let command = parts[1];
        let cwd = parts[2];
        let session = parts[3];
        let window = parts[4];
        let pane_pid = parts[5];
        let window_id = parts[6];
        let pane_title = normalize_optional_text(parts[7].to_string());
        let pane_slug_tag = parts
            .get(8)
            .and_then(|s| normalize_optional_text(s.to_string()));

        if is_view_session(session) {
            continue;
        }

        let provider = detect_process_provider(pane_pid, Some(&process_snapshot))
            .or_else(|| is_semver(command).then_some(ProcessProvider::Claude));
        let Some(provider) = provider else {
            continue;
        };

        if !seen_panes.insert(pane_id.to_string()) {
            continue;
        }

        let (matched_group, matched_job) = if let Some(group_val) =
            overrides.get(pane_id).and_then(|o| o.group_override.as_ref())
        {
            let group = if group_val.is_empty() { None } else { Some(group_val.clone()) };
            (group, None)
        } else if let Some((group, slug)) = running_panes.get(pane_id) {
            if pane_slug_tag.as_deref() != Some(slug.as_str()) {
                let _ = crate::tmux::set_pane_slug(pane_id, slug);
            }
            (Some(group.clone()), Some(slug.clone()))
        } else if let Some(group) = pane_slug_tag
            .as_ref()
            .and_then(|tag| slug_to_group.get(tag))
        {
            // Pane was tagged with a job slug at spawn time via tmux user
            // option. Authoritative — unlike pane_title it can't be overwritten
            // by the running process's terminal output.
            (Some(group.clone()), pane_slug_tag.clone())
        } else if let Some(job_match) = history_panes.get(pane_id).filter(|job_match| {
            job_match
                .root
                .as_ref()
                .is_none_or(|root| cwd == root || cwd.starts_with(&format!("{}/", root)))
        }) {
            // Tmux recycles pane IDs, so historical runs from days ago may
            // point to a completely different session that reused the same ID.
            // Only trust the job slug (which nests under that job's card) if
            // the run started recently. Otherwise fall back to group-only.
            if is_recent_history(&job_match.started_at) {
                // Backfill the tag so future detections don't depend on the
                // 12-hour trust window.
                let _ = crate::tmux::set_pane_slug(pane_id, &job_match.slug);
                (Some(job_match.group.clone()), Some(job_match.slug.clone()))
            } else {
                (Some(job_match.group.clone()), None)
            }
        } else {
            let best = match_entries
                .iter()
                .filter(|(root, _, _)| cwd == root || cwd.starts_with(&format!("{}/", root)))
                .max_by_key(|(root, _, _)| root.len());
            match best {
                Some((_, group, _)) => (Some(group.clone()), None),
                None => (None, None),
            }
        };

        let log_lines = if live_viewer_panes.contains(pane_id) {
            String::new()
        } else {
            crate::tmux::capture_pane(session, pane_id, 5)
                .unwrap_or_default()
                .trim()
                .to_string()
        };

        let session_info = crate::agent_session::resolve_session_info_for_provider_with_cwd(
            pane_pid,
            Some(provider),
            Some(&process_snapshot),
            Some(cwd),
        );
        let override_meta = overrides.get(pane_id);
        let (can_fork_session, can_send_skills, can_inject_secrets) =
            provider_capabilities(provider);
        let version = if is_semver(command) {
            command.to_string()
        } else {
            process_snapshot
                .command_for_pid(pane_pid)
                .and_then(detect_version_from_command)
                .unwrap_or_default()
        };

        results.push(DetectedProcess {
            pane_id: pane_id.to_string(),
            cwd: cwd.to_string(),
            version,
            display_name: override_meta.and_then(|meta| meta.display_name.clone()),
            pane_title,
            provider: provider.as_str().to_string(),
            can_fork_session,
            can_send_skills,
            can_inject_secrets,
            tmux_session: resolve_non_view_session_for_window(window_id, session),
            window_name: window.to_string(),
            matched_group,
            matched_job,
            log_lines,
            first_query: override_meta
                .and_then(|meta| meta.first_query.clone())
                .or(session_info.first_query),
            last_query: override_meta
                .and_then(|meta| meta.last_query.clone())
                .or(session_info.last_query),
            session_started_at: session_info.session_started_at,
            token_count: session_info.token_count,
        });
    }

    Ok(DetectionSnapshot { processes: results })
}

#[tauri::command]
pub fn set_detected_process_display_name(
    state: State<'_, AppState>,
    pane_id: String,
    display_name: Option<String>,
) -> Result<(), String> {
    let mut overrides = state.process_overrides.lock().unwrap();
    let entry = overrides.entry(pane_id).or_default();
    entry.display_name = display_name.and_then(normalize_optional_text);
    prune_empty_overrides(&mut overrides);
    let snapshot = overrides.clone();
    drop(overrides);
    persist_process_overrides(&state, snapshot)
}

#[tauri::command]
pub fn set_detected_process_queries(
    state: State<'_, AppState>,
    pane_id: String,
    first_query: Option<String>,
    last_query: Option<String>,
) -> Result<(), String> {
    let mut overrides = state.process_overrides.lock().unwrap();
    let entry = overrides.entry(pane_id).or_default();
    entry.first_query = first_query.and_then(normalize_optional_text);
    entry.last_query = last_query.and_then(normalize_optional_text);
    prune_empty_overrides(&mut overrides);
    let snapshot = overrides.clone();
    drop(overrides);
    persist_process_overrides(&state, snapshot)
}

#[tauri::command]
pub fn set_detected_process_group(
    state: State<'_, AppState>,
    pane_id: String,
    group: String,
) -> Result<(), String> {
    let mut overrides = state.process_overrides.lock().unwrap();
    let entry = overrides.entry(pane_id).or_default();
    // "" signals "independent" (no group); non-empty signals pinned to that group.
    entry.group_override = Some(group.trim().to_string());
    prune_empty_overrides(&mut overrides);
    let snapshot = overrides.clone();
    drop(overrides);
    persist_process_overrides(&state, snapshot)
}

fn prune_stale_process_overrides(
    state: &State<'_, AppState>,
    detected_pane_ids: &HashSet<String>,
) -> Result<(), String> {
    let mut overrides = state.process_overrides.lock().unwrap();
    let before_len = overrides.len();
    overrides.retain(|pane_id, _| detected_pane_ids.contains(pane_id));
    if overrides.len() == before_len {
        return Ok(());
    }
    let snapshot = overrides.clone();
    drop(overrides);
    persist_process_overrides(state, snapshot)
}

fn normalize_optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn prune_empty_overrides(overrides: &mut HashMap<String, DetectedProcessOverride>) {
    overrides.retain(|_, meta| {
        meta.display_name.is_some()
            || meta.first_query.is_some()
            || meta.last_query.is_some()
            || meta.group_override.is_some()
    });
}

fn persist_process_overrides(
    state: &State<'_, AppState>,
    overrides: HashMap<String, DetectedProcessOverride>,
) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    let on_disk = crate::config::settings::AppSettings::load();
    if settings.telegram.is_none() {
        settings.telegram = on_disk.telegram;
    }
    if settings.relay.is_none() {
        settings.relay = on_disk.relay;
    }
    settings.process_overrides = overrides;
    settings.save()
}

#[tauri::command]
pub fn focus_detected_process(tmux_session: String, window_name: String) -> Result<(), String> {
    if !crate::tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }
    crate::tmux::focus_window(&tmux_session, &window_name)
}

#[tauri::command]
pub fn get_detected_process_logs(tmux_session: String, pane_id: String) -> Result<String, String> {
    crate::tmux::capture_pane(&tmux_session, &pane_id, 200)
}

#[tauri::command]
pub fn send_detected_process_input(
    pane_id: String,
    text: String,
    col: Option<u16>,
    row: Option<u16>,
) -> Result<(), String> {
    if let (Some(c), Some(r)) = (col, row) {
        crate::tmux::send_mouse_click_to_pane(&pane_id, c, r)
    } else {
        crate::tmux::send_keys_to_tui_pane(&pane_id, &text)
    }
}

#[tauri::command]
pub async fn get_active_questions(
    _state: State<'_, AppState>,
) -> Result<Vec<clawtab_protocol::ClaudeQuestion>, String> {
    match crate::ipc::send_command(crate::ipc::IpcCommand::GetActiveQuestions).await {
        Ok(crate::ipc::IpcResponse::ActiveQuestions(qs)) => Ok(qs),
        Ok(resp) => Err(format!("Unexpected IPC response: {:?}", resp)),
        Err(e) => Err(format!("Daemon unavailable: {}", e)),
    }
}

#[tauri::command]
pub async fn get_auto_yes_panes(_state: State<'_, AppState>) -> Result<Vec<String>, String> {
    match crate::ipc::send_command(crate::ipc::IpcCommand::GetAutoYesPanes).await {
        Ok(crate::ipc::IpcResponse::AutoYesPanes(panes)) => Ok(panes),
        Ok(resp) => Err(format!("Unexpected IPC response: {:?}", resp)),
        Err(e) => Err(format!("Daemon unavailable: {}", e)),
    }
}

#[tauri::command]
pub async fn set_auto_yes_panes(
    _state: State<'_, AppState>,
    pane_ids: Vec<String>,
) -> Result<(), String> {
    match crate::ipc::send_command(crate::ipc::IpcCommand::SetAutoYesPanes { pane_ids }).await {
        Ok(crate::ipc::IpcResponse::Ok) => Ok(()),
        Ok(crate::ipc::IpcResponse::Error(e)) => Err(e),
        Ok(resp) => Err(format!("Unexpected IPC response: {:?}", resp)),
        Err(e) => Err(format!("Daemon unavailable: {}", e)),
    }
}

/// Replace the set of panes currently open in ClawTab's UI. Background
/// cleanup paths skip any pane in this set, so a pane visible to the user
/// (even as a plain shell) is never killed behind their back.
#[tauri::command]
pub async fn set_protected_panes(
    _state: State<'_, AppState>,
    pane_ids: Vec<String>,
) -> Result<(), String> {
    match crate::ipc::send_command(crate::ipc::IpcCommand::SetProtectedPanes { pane_ids }).await {
        Ok(crate::ipc::IpcResponse::Ok) => Ok(()),
        Ok(crate::ipc::IpcResponse::Error(e)) => Err(e),
        Ok(resp) => Err(format!("Unexpected IPC response: {:?}", resp)),
        Err(e) => Err(format!("Daemon unavailable: {}", e)),
    }
}

#[tauri::command]
pub fn sigint_detected_process(pane_id: String) -> Result<(), String> {
    crate::tmux::send_sigint_to_pane(&pane_id)?;
    std::thread::sleep(std::time::Duration::from_millis(200));
    crate::tmux::send_sigint_to_pane(&pane_id)
}

#[tauri::command]
pub fn stop_detected_process(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    crate::tmux::kill_pane(&pane_id)?;
    let mut overrides = state.process_overrides.lock().unwrap();
    if overrides.remove(&pane_id).is_none() {
        return Ok(());
    }
    let snapshot = overrides.clone();
    drop(overrides);
    persist_process_overrides(&state, snapshot)
}

#[tauri::command]
pub fn get_existing_pane_info(pane_id: String) -> Result<Option<ExistingPaneInfo>, String> {
    if !crate::tmux::pane_exists(&pane_id) {
        return Ok(None);
    }

    let output = debug_spawn::run_logged(
        "tmux",
        &[
            "display-message",
            "-t",
            &pane_id,
            "-p",
            "#{pane_id}\t#{pane_current_path}\t#{session_name}\t#{window_name}\t#{window_id}\t#{pane_title}",
        ],
        "processes::get_existing_pane_info::display-message",
    )
    .map_err(|e| format!("Failed to inspect tmux pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("can't find pane") || stderr.contains("no server running") {
            return Ok(None);
        }
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parts = stdout.trim_end().splitn(6, '\t');
    let Some(found_pane_id) = parts.next() else {
        return Ok(None);
    };
    let Some(cwd) = parts.next() else {
        return Ok(None);
    };
    let Some(tmux_session) = parts.next() else {
        return Ok(None);
    };
    let Some(window_name) = parts.next() else {
        return Ok(None);
    };
    let Some(window_id) = parts.next() else {
        return Ok(None);
    };
    let pane_title = parts.next().map(|value| normalize_optional_text(value.to_string())).flatten();

    Ok(Some(ExistingPaneInfo {
        pane_id: found_pane_id.to_string(),
        cwd: cwd.to_string(),
        tmux_session: resolve_non_view_session_for_window(window_id, tmux_session),
        window_name: window_name.to_string(),
        pane_title,
    }))
}
