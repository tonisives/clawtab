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
    pub matched_group: Option<String>,
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
        &[
            "list-windows",
            "-a",
            "-F",
            "#{session_name}|CT|#{window_id}",
        ],
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
        let mut parts = line.splitn(2, "|CT|");
        let session = parts.next().unwrap_or("");
        let current_window_id = parts.next().unwrap_or("");
        if current_window_id == window_id && !is_view_session(session) {
            return session.to_string();
        }
    }

    fallback.to_string()
}

fn non_view_sessions_by_window() -> HashMap<String, String> {
    let Ok(rows) = crate::tmux::list_all_windows_with_session() else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for (session, window_id) in rows {
        if !is_view_session(&session) {
            out.entry(window_id).or_insert(session);
        }
    }
    out
}

fn resolve_non_view_session_from_map(
    by_window: &HashMap<String, String>,
    window_id: &str,
    fallback: &str,
) -> String {
    by_window
        .get(window_id)
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
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
        ProcessProvider::Antigravity => (false, false, false),
        ProcessProvider::Shell => (false, false, false),
    }
}

#[tauri::command]
pub async fn detect_processes(state: State<'_, AppState>) -> Result<Vec<DetectedProcess>, String> {
    let live_viewer_panes: HashSet<String> = { state.pty_manager.lock().active_pane_ids() };
    let match_entries = collect_match_entries(&state);
    let slug_to_group = collect_slug_to_group(&state);
    let history_panes = collect_history_panes(&state);
    let running_panes = collect_running_panes(&state).await;
    let overrides = state.process_overrides.lock().clone();

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

fn collect_match_entries(state: &State<'_, AppState>) -> Vec<(String, String, String)> {
    let config = state.jobs_config.lock();
    config
        .jobs
        .iter()
        .filter_map(|job| {
            if let Some(ref fp) = job.folder_path {
                Some((fp.clone(), job.group.clone(), job.slug.clone()))
            } else {
                job.work_dir
                    .as_ref()
                    .map(|wd| (wd.clone(), job.group.clone(), job.slug.clone()))
            }
        })
        .collect()
}

fn collect_slug_to_group(state: &State<'_, AppState>) -> HashMap<String, String> {
    let config = state.jobs_config.lock();
    config
        .jobs
        .iter()
        .map(|job| (job.slug.clone(), job.group.clone()))
        .collect()
}

fn collect_history_panes(state: &State<'_, AppState>) -> HashMap<String, PaneJobMatch> {
    #[derive(Clone)]
    struct JobInfo {
        group: String,
        root: Option<String>,
    }
    let jobs_by_slug: HashMap<String, JobInfo> = {
        let config = state.jobs_config.lock();
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
    let recent = state.history.lock().get_recent(500).unwrap_or_default();
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
}

async fn collect_running_panes(state: &State<'_, AppState>) -> HashMap<String, (String, String)> {
    let statuses: HashMap<String, JobStatus> =
        match crate::ipc::send_command(crate::ipc::IpcCommand::GetStatus).await {
            Ok(crate::ipc::IpcResponse::Status(s)) => s,
            _ => HashMap::new(),
        };
    let config = state.jobs_config.lock();
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
}

struct PaneRow<'a> {
    pane_id: &'a str,
    command: &'a str,
    cwd: &'a str,
    session: &'a str,
    window: &'a str,
    pane_pid: &'a str,
    window_id: &'a str,
    pane_title: Option<String>,
    pane_slug_tag: Option<String>,
}

struct DetectCtx<'a> {
    live_viewer_panes: &'a HashSet<String>,
    match_entries: &'a [(String, String, String)],
    running_panes: &'a HashMap<String, (String, String)>,
    history_panes: &'a HashMap<String, PaneJobMatch>,
    slug_to_group: &'a HashMap<String, String>,
    overrides: &'a HashMap<String, DetectedProcessOverride>,
    process_snapshot: &'a crate::agent_session::ProcessSnapshot,
    non_view_sessions_by_window: &'a HashMap<String, String>,
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
    let stdout = match list_tmux_panes()? {
        Some(s) => s,
        None => {
            return Ok(DetectionSnapshot {
                processes: Vec::new(),
            })
        }
    };
    let non_view_sessions = non_view_sessions_by_window();

    let ctx = DetectCtx {
        live_viewer_panes: &live_viewer_panes,
        match_entries: &match_entries,
        running_panes: &running_panes,
        history_panes: &history_panes,
        slug_to_group: &slug_to_group,
        overrides: &overrides,
        process_snapshot: &process_snapshot,
        non_view_sessions_by_window: &non_view_sessions,
    };

    let mut seen_panes = HashSet::new();
    let mut results = Vec::new();
    for line in stdout.lines() {
        let Some(row) = parse_pane_row(line) else {
            continue;
        };
        if is_view_session(row.session) {
            continue;
        }
        let Some(provider) = pick_provider(&row, &process_snapshot) else {
            continue;
        };
        if !seen_panes.insert(row.pane_id.to_string()) {
            continue;
        }
        results.push(build_detected_process(&row, provider, &ctx));
    }

    Ok(DetectionSnapshot { processes: results })
}

fn list_tmux_panes() -> Result<Option<String>, String> {
    let output = debug_spawn::run_logged(
        "tmux",
        &[
            "list-panes",
            "-a",
            "-F",
            "#{pane_id}|CT|#{pane_current_command}|CT|#{pane_current_path}|CT|#{session_name}|CT|#{window_name}|CT|#{pane_pid}|CT|#{window_id}|CT|#{pane_title}|CT|#{@clawtab-slug}",
        ],
        "processes::detect_processes::list-panes",
    );
    match output {
        Ok(o) if o.status.success() => Ok(Some(String::from_utf8_lossy(&o.stdout).to_string())),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            if stderr.contains("no server running") || stderr.contains("no sessions") {
                Ok(None)
            } else {
                Err(format!("tmux error: {}", stderr.trim()))
            }
        }
        Err(e) => Err(format!("Failed to run tmux: {}", e)),
    }
}

fn parse_pane_row(line: &str) -> Option<PaneRow<'_>> {
    let parts: Vec<&str> = line.splitn(9, "|CT|").collect();
    if parts.len() < 8 {
        return None;
    }
    Some(PaneRow {
        pane_id: parts[0],
        command: parts[1],
        cwd: parts[2],
        session: parts[3],
        window: parts[4],
        pane_pid: parts[5],
        window_id: parts[6],
        pane_title: normalize_optional_text(parts[7].to_string()),
        pane_slug_tag: parts
            .get(8)
            .and_then(|s| normalize_optional_text((*s).to_string())),
    })
}

fn pick_provider(
    row: &PaneRow<'_>,
    process_snapshot: &crate::agent_session::ProcessSnapshot,
) -> Option<ProcessProvider> {
    detect_process_provider(row.pane_pid, Some(process_snapshot))
        .or_else(|| provider_from_tmux_command(row.command))
        .or_else(|| is_semver(row.command).then_some(ProcessProvider::Claude))
}

fn provider_from_tmux_command(command: &str) -> Option<ProcessProvider> {
    let lower = command.to_ascii_lowercase();
    if lower.contains("codex") {
        Some(ProcessProvider::Codex)
    } else if lower.contains("opencode") {
        Some(ProcessProvider::Opencode)
    } else if lower.contains("agy") || lower.contains("antigravity") {
        Some(ProcessProvider::Antigravity)
    } else if lower.contains("claude") {
        Some(ProcessProvider::Claude)
    } else {
        None
    }
}

fn resolve_group_and_job(
    row: &PaneRow<'_>,
    ctx: &DetectCtx<'_>,
    override_meta: Option<&DetectedProcessOverride>,
) -> (Option<String>, Option<String>) {
    if let Some(group_val) = override_meta.and_then(|meta| meta.group_override.as_ref()) {
        let group = if group_val.is_empty() {
            None
        } else {
            Some(group_val.clone())
        };
        return (group, None);
    }
    if let Some((group, slug)) = ctx.running_panes.get(row.pane_id) {
        if row.pane_slug_tag.as_deref() != Some(slug.as_str()) {
            let _ = crate::tmux::set_pane_slug(row.pane_id, slug);
        }
        return (Some(group.clone()), Some(slug.clone()));
    }
    if let Some(group) = row
        .pane_slug_tag
        .as_ref()
        .and_then(|tag| ctx.slug_to_group.get(tag))
    {
        // Pane was tagged with a job slug at spawn time via tmux user option.
        // Authoritative - pane_title can be overwritten by terminal output.
        return (Some(group.clone()), row.pane_slug_tag.clone());
    }
    if let Some(job_match) = ctx.history_panes.get(row.pane_id).filter(|job_match| {
        job_match
            .root
            .as_ref()
            .is_none_or(|root| row.cwd == root || row.cwd.starts_with(&format!("{}/", root)))
    }) {
        // Tmux recycles pane IDs, so historical runs from days ago may
        // refer to a different session that reused the same ID. Only trust
        // the job slug if the run started recently; otherwise group-only.
        if is_recent_history(&job_match.started_at) {
            let _ = crate::tmux::set_pane_slug(row.pane_id, &job_match.slug);
            return (Some(job_match.group.clone()), Some(job_match.slug.clone()));
        }
        return (Some(job_match.group.clone()), None);
    }
    let best = ctx
        .match_entries
        .iter()
        .filter(|(root, _, _)| row.cwd == root || row.cwd.starts_with(&format!("{}/", root)))
        .max_by_key(|(root, _, _)| root.len());
    match best {
        Some((_, group, _)) => (Some(group.clone()), None),
        None => (None, None),
    }
}

fn capture_log_lines(_row: &PaneRow<'_>, _live_viewer_panes: &HashSet<String>) -> String {
    String::new()
}

fn resolve_version(
    row: &PaneRow<'_>,
    process_snapshot: &crate::agent_session::ProcessSnapshot,
) -> String {
    if is_semver(row.command) {
        return row.command.to_string();
    }
    process_snapshot
        .command_for_pid(row.pane_pid)
        .and_then(detect_version_from_command)
        .unwrap_or_default()
}

fn build_detected_process(
    row: &PaneRow<'_>,
    provider: ProcessProvider,
    ctx: &DetectCtx<'_>,
) -> DetectedProcess {
    let log_lines = capture_log_lines(row, ctx.live_viewer_panes);
    let session_info = crate::agent_session::resolve_session_info_for_provider_with_cwd(
        row.pane_pid,
        Some(provider),
        Some(ctx.process_snapshot),
        Some(row.cwd),
    );
    let override_meta = ctx
        .overrides
        .get(row.pane_id)
        .filter(|meta| meta.matches_identity(row.pane_pid, session_info.session_id.as_deref()));
    let (matched_group, matched_job) = resolve_group_and_job(row, ctx, override_meta);
    let (can_fork_session, can_send_skills, can_inject_secrets) = provider_capabilities(provider);
    let version = resolve_version(row, ctx.process_snapshot);

    DetectedProcess {
        pane_id: row.pane_id.to_string(),
        cwd: row.cwd.to_string(),
        version,
        display_name: override_meta.and_then(|meta| meta.display_name.clone()),
        pane_title: row.pane_title.clone(),
        provider: provider.as_str().to_string(),
        can_fork_session,
        can_send_skills,
        can_inject_secrets,
        tmux_session: resolve_non_view_session_from_map(
            ctx.non_view_sessions_by_window,
            row.window_id,
            row.session,
        ),
        window_name: row.window.to_string(),
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
    }
}

#[tauri::command]
pub fn set_detected_process_display_name(
    state: State<'_, AppState>,
    pane_id: String,
    display_name: Option<String>,
) -> Result<(), String> {
    set_process_display_name(&state, pane_id, display_name)
}

#[tauri::command]
pub fn clear_agent_pane_title(state: State<'_, AppState>, pane_id: String) -> Result<(), String> {
    crate::tmux::clear_pane_display_name(&pane_id)?;
    set_process_display_name(&state, pane_id, None)
}

pub fn set_process_display_name(
    state: &AppState,
    pane_id: String,
    display_name: Option<String>,
) -> Result<(), String> {
    let display_name = display_name.and_then(normalize_optional_text);
    let identity = display_name
        .as_ref()
        .map(|_| resolve_process_override_identity(&pane_id))
        .transpose()?;
    let mut overrides = state.process_overrides.lock();
    let entry = overrides.entry(pane_id).or_default();
    entry.display_name = display_name;
    if let Some((pane_pid, session_id)) = identity {
        entry.set_identity(pane_pid, session_id);
    }
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
    let identity = resolve_process_override_identity(&pane_id)?;
    let mut overrides = state.process_overrides.lock();
    let entry = overrides.entry(pane_id).or_default();
    entry.first_query = first_query.and_then(normalize_optional_text);
    entry.last_query = last_query.and_then(normalize_optional_text);
    entry.set_identity(identity.0, identity.1);
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
    let identity = resolve_process_override_identity(&pane_id)?;
    let mut overrides = state.process_overrides.lock();
    let entry = overrides.entry(pane_id).or_default();
    // "" signals "independent" (no group); non-empty signals pinned to that group.
    entry.group_override = Some(group.trim().to_string());
    entry.set_identity(identity.0, identity.1);
    prune_empty_overrides(&mut overrides);
    let snapshot = overrides.clone();
    drop(overrides);
    persist_process_overrides(&state, snapshot)
}

fn prune_stale_process_overrides(
    state: &State<'_, AppState>,
    detected_pane_ids: &HashSet<String>,
) -> Result<(), String> {
    let mut overrides = state.process_overrides.lock();
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

fn resolve_process_override_identity(pane_id: &str) -> Result<(String, Option<String>), String> {
    let output = debug_spawn::run_logged(
        "tmux",
        &[
            "display-message",
            "-t",
            pane_id,
            "-p",
            "#{pane_pid}|CT|#{pane_current_path}",
        ],
        "processes::resolve_process_override_identity",
    )
    .map_err(|error| format!("Failed to inspect tmux pane: {}", error))?;
    if !output.status.success() {
        return Err(format!(
            "tmux error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let (pane_pid, pane_cwd) = raw
        .trim_end()
        .split_once("|CT|")
        .ok_or_else(|| "tmux returned malformed pane identity".to_string())?;
    if pane_pid.is_empty() {
        return Err("tmux returned an empty pane PID".to_string());
    }

    let snapshot = crate::agent_session::ProcessSnapshot::capture();
    let provider = detect_process_provider(pane_pid, Some(&snapshot));
    let session_id = crate::agent_session::resolve_session_info_for_provider_with_cwd(
        pane_pid,
        provider,
        Some(&snapshot),
        (!pane_cwd.is_empty()).then_some(pane_cwd),
    )
    .session_id;

    Ok((pane_pid.to_string(), session_id))
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
    state: &AppState,
    overrides: HashMap<String, DetectedProcessOverride>,
) -> Result<(), String> {
    let mut settings = state.settings.lock();
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
    let mut overrides = state.process_overrides.lock();
    if overrides.remove(&pane_id).is_none() {
        return Ok(());
    }
    let snapshot = overrides.clone();
    drop(overrides);
    persist_process_overrides(&state, snapshot)
}

#[tauri::command]
pub fn get_existing_pane_info(
    state: State<'_, AppState>,
    pane_id: String,
) -> Result<Option<ExistingPaneInfo>, String> {
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
            "#{pane_id}|CT|#{pane_current_path}|CT|#{session_name}|CT|#{window_name}|CT|#{window_id}|CT|#{pane_title}|CT|#{@clawtab-slug}",
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
    let mut parts = stdout.trim_end().splitn(7, "|CT|");
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
    let pane_title = parts
        .next()
        .map(|value| normalize_optional_text(value.to_string()))
        .flatten();
    let pane_slug_tag = parts
        .next()
        .and_then(|value| normalize_optional_text(value.to_string()));

    let matched_group = resolve_pane_group(&state, found_pane_id, cwd, pane_slug_tag.as_deref());

    Ok(Some(ExistingPaneInfo {
        pane_id: found_pane_id.to_string(),
        cwd: cwd.to_string(),
        tmux_session: resolve_non_view_session_for_window(window_id, tmux_session),
        window_name: window_name.to_string(),
        pane_title,
        matched_group,
    }))
}

/// Resolve a pane's group using the same priority as `detect_processes`, but
/// without the running-job or history-trust steps (those require more state and
/// are racy outside of a full detection pass).
///
/// Priority: explicit `group_override` -> tmux `@clawtab-slug` tag -> longest
/// pwd-prefix match against job folder_path/work_dir. Empty string overrides
/// signal "no group" (independent) and are returned as None.
fn resolve_pane_group(
    state: &State<'_, AppState>,
    pane_id: &str,
    cwd: &str,
    pane_slug_tag: Option<&str>,
) -> Option<String> {
    if let Some(override_entry) = state.process_overrides.lock().get(pane_id) {
        if let Some(group_val) = override_entry.group_override.as_ref() {
            if group_val.is_empty() {
                return None;
            }
            return Some(group_val.clone());
        }
    }

    let config = state.jobs_config.lock();

    if let Some(tag) = pane_slug_tag {
        if let Some(job) = config.jobs.iter().find(|job| job.slug == tag) {
            return Some(job.group.clone());
        }
    }

    config
        .jobs
        .iter()
        .filter_map(|job| {
            let root = job.folder_path.as_deref().or(job.work_dir.as_deref())?;
            if cwd == root || cwd.starts_with(&format!("{}/", root)) {
                Some((root.to_string(), job.group.clone()))
            } else {
                None
            }
        })
        .max_by_key(|(root, _)| root.len())
        .map(|(_, group)| group)
}
