use base64::Engine;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use clawtab_protocol::{
    ClientMessage, DesktopMessage, DetectedProcess as RemoteDetectedProcess,
    JobStatus as RemoteJobStatus, RemoteJob,
};

use crate::config::jobs::{JobStatus, JobsConfig};
use crate::events::EventSink;
use crate::history::HistoryStore;
use crate::job_context::JobContext;

use crate::pty::{OutputSink, SharedPtyManager};

use super::{job_to_remote, status_to_remote, RelayHandle};

/// Handle a message received from the relay server (forwarded from a mobile client).
/// Returns a JSON response string to send back, or None.
pub async fn handle_incoming(
    text: &str,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &JobContext,
    pty_manager: &SharedPtyManager,
    event_sink: &dyn EventSink,
) -> Option<String> {
    let msg: ClientMessage = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(_) => {
            log::debug!(
                "Relay: ignoring non-client message: {}",
                &text[..text.len().min(100)]
            );
            return None;
        }
    };

    let response = dispatch_message(msg, jobs_config, ctx, pty_manager, event_sink).await;
    serialize_response(response)
}

fn serialize_response(response: Option<DesktopMessage>) -> Option<String> {
    let resp = response?;
    match serde_json::to_string(&resp) {
        Ok(json) => {
            log::debug!("Relay response: {}", &json[..json.len().min(200)]);
            Some(json)
        }
        Err(e) => {
            log::error!("Failed to serialize relay response: {}", e);
            None
        }
    }
}

async fn dispatch_message(
    msg: ClientMessage,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &JobContext,
    pty_manager: &SharedPtyManager,
    event_sink: &dyn EventSink,
) -> Option<DesktopMessage> {
    match msg {
        ClientMessage::DetectProcesses { id } => {
            Some(handle_detect_processes(id, jobs_config, &ctx.job_status).await)
        }
        ClientMessage::SubscribePty {
            id,
            pane_id,
            tmux_session,
            cols,
            rows,
        } => Some(handle_subscribe_pty(
            id,
            pane_id,
            tmux_session,
            cols,
            rows,
            pty_manager,
            &ctx.relay,
        )),
        other => dispatch_sync(other, jobs_config, ctx, pty_manager, event_sink),
    }
}

fn dispatch_sync(
    msg: ClientMessage,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &JobContext,
    pty_manager: &SharedPtyManager,
    event_sink: &dyn EventSink,
) -> Option<DesktopMessage> {
    if let Some(resp) = dispatch_job_msg(&msg, jobs_config, ctx, event_sink) {
        return Some(resp);
    }
    if let Some(resp) = dispatch_process_msg(&msg, &ctx.history) {
        return Some(resp);
    }
    dispatch_pty_msg(msg, ctx, pty_manager, event_sink)
}

fn dispatch_job_msg(
    msg: &ClientMessage,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &JobContext,
    event_sink: &dyn EventSink,
) -> Option<DesktopMessage> {
    let job_status = &ctx.job_status;
    let relay = &ctx.relay;
    match msg {
        ClientMessage::ListJobs { id } => {
            Some(handle_list_jobs(id.clone(), jobs_config, job_status))
        }
        ClientMessage::RunJob {
            id,
            name,
            params,
            trigger_id,
        } => {
            let result = run_job(name, params, trigger_id.clone(), jobs_config, ctx);
            event_sink.emit_jobs_changed();
            Some(DesktopMessage::RunJobAck {
                id: id.clone(),
                success: result.is_ok(),
                error: result.err(),
            })
        }
        ClientMessage::PauseJob { id, name } => {
            let result = pause_job(name, job_status);
            event_sink.emit_jobs_changed();
            Some(DesktopMessage::PauseJobAck {
                id: id.clone(),
                success: result.is_ok(),
                error: result.err(),
            })
        }
        ClientMessage::ResumeJob { id, name } => {
            let result = resume_job(name, job_status);
            event_sink.emit_jobs_changed();
            Some(DesktopMessage::ResumeJobAck {
                id: id.clone(),
                success: result.is_ok(),
                error: result.err(),
            })
        }
        ClientMessage::StopJob { id, name } => {
            let result = stop_job(name, job_status, relay);
            event_sink.emit_jobs_changed();
            Some(DesktopMessage::StopJobAck {
                id: id.clone(),
                success: result.is_ok(),
                error: result.err(),
            })
        }
        ClientMessage::SendInput {
            id,
            name,
            text,
            freetext,
        } => {
            let result = if let Some(ft) = freetext {
                send_input_freetext(name, text, ft, job_status)
            } else {
                send_input(name, text, job_status)
            };
            Some(DesktopMessage::SendInputAck {
                id: id.clone(),
                success: result.is_ok(),
            })
        }
        ClientMessage::SubscribeLogs { id, name } => {
            Some(handle_subscribe_logs(id.clone(), name, job_status, relay))
        }
        ClientMessage::RunAgent {
            id,
            prompt,
            work_dir,
            trigger_id,
        } => {
            let result = run_agent(
                prompt,
                work_dir.as_deref(),
                trigger_id.clone(),
                jobs_config,
                ctx,
            );
            Some(DesktopMessage::RunAgentAck {
                id: id.clone(),
                success: result.is_ok(),
                job_id: result.ok(),
            })
        }
        ClientMessage::CreateJob { id, .. } => {
            let result = create_job();
            if result.is_ok() {
                event_sink.emit_jobs_changed();
            }
            Some(DesktopMessage::CreateJobAck {
                id: id.clone(),
                success: result.is_ok(),
                error: result.err(),
            })
        }
        _ => None,
    }
}

fn dispatch_process_msg(
    msg: &ClientMessage,
    history: &Arc<Mutex<HistoryStore>>,
) -> Option<DesktopMessage> {
    match msg {
        ClientMessage::GetRunHistory { id, name, limit } => {
            let runs = get_run_history(name, *limit, history);
            Some(DesktopMessage::RunHistory {
                id: id.clone(),
                runs,
            })
        }
        ClientMessage::GetRunDetail { id, run_id } => {
            let detail = get_run_detail_full(run_id, history);
            Some(DesktopMessage::RunDetailResponse {
                id: id.clone(),
                detail,
            })
        }
        ClientMessage::GetDetectedProcessLogs {
            id,
            tmux_session,
            pane_id,
        } => {
            let logs = crate::tmux::capture_pane(tmux_session, pane_id, 200).unwrap_or_default();
            Some(DesktopMessage::DetectedProcessLogs {
                id: id.clone(),
                logs,
            })
        }
        ClientMessage::SendDetectedProcessInput { id, pane_id, text } => {
            let result = crate::tmux::send_keys_to_tui_pane(pane_id, text);
            Some(DesktopMessage::SendDetectedProcessInputAck {
                id: id.clone(),
                success: result.is_ok(),
            })
        }
        ClientMessage::StopDetectedProcess { id, pane_id } => {
            let result = crate::tmux::kill_pane(pane_id);
            Some(DesktopMessage::StopDetectedProcessAck {
                id: id.clone(),
                success: result.is_ok(),
                error: result.err(),
            })
        }
        ClientMessage::AnswerQuestion {
            id,
            pane_id,
            answer,
            freetext,
            ..
        } => {
            let result = if let Some(text) = freetext {
                crate::tmux::send_keys_to_tui_pane_freetext(pane_id, answer, text)
            } else {
                crate::tmux::send_keys_to_tui_pane(pane_id, answer)
            };
            Some(DesktopMessage::SendDetectedProcessInputAck {
                id: id.clone(),
                success: result.is_ok(),
            })
        }
        _ => None,
    }
}

fn dispatch_pty_msg(
    msg: ClientMessage,
    ctx: &JobContext,
    pty_manager: &SharedPtyManager,
    event_sink: &dyn EventSink,
) -> Option<DesktopMessage> {
    match msg {
        ClientMessage::GetSettings { id } => Some(handle_get_settings(id, &ctx.settings)),
        ClientMessage::SetAutoYesPanes { pane_ids, .. } => {
            handle_set_auto_yes_panes(pane_ids, &ctx.auto_yes_panes, &ctx.relay, event_sink);
            None
        }
        ClientMessage::UnsubscribePty { pane_id } => {
            let _ = pty_manager.lock().destroy(&pane_id, None);
            None
        }
        ClientMessage::PtyInput { pane_id, data } => {
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&data) {
                let _ = pty_manager.lock().write(&pane_id, &bytes);
            }
            None
        }
        ClientMessage::PtyResize {
            pane_id,
            cols,
            rows,
        } => {
            let _ = pty_manager
                .lock()
                .resize(&pane_id, cols as u16, rows as u16);
            None
        }
        _ => None,
    }
}

fn handle_list_jobs(
    id: String,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> DesktopMessage {
    let jobs = jobs_config.lock().jobs.clone();
    let statuses = job_status.lock().clone();
    let remote_jobs: Vec<RemoteJob> = jobs.iter().map(job_to_remote).collect();
    let remote_statuses: HashMap<String, RemoteJobStatus> = statuses
        .into_iter()
        .map(|(k, v)| (k, status_to_remote(&v)))
        .collect();
    log::info!(
        "ListJobs: returning {} jobs, {} statuses (id={})",
        remote_jobs.len(),
        remote_statuses.len(),
        id
    );
    DesktopMessage::JobsList {
        id,
        jobs: remote_jobs,
        statuses: remote_statuses,
    }
}

fn handle_subscribe_logs(
    id: String,
    name: &str,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
) -> DesktopMessage {
    let statuses = job_status.lock();
    if let Some(JobStatus::Running {
        pane_id: Some(pane_id),
        tmux_session: Some(session),
        ..
    }) = statuses.get(name)
    {
        if let Ok(content) = crate::tmux::capture_pane(session, pane_id, 200) {
            let content = content.trim().to_string();
            if !content.is_empty() {
                super::push_log_chunk(relay, name, &content);
            }
        }
    }
    drop(statuses);
    DesktopMessage::SubscribeLogsAck { id, success: true }
}

async fn handle_detect_processes(
    id: String,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> DesktopMessage {
    let jc = Arc::clone(jobs_config);
    let js = Arc::clone(job_status);
    let processes = tokio::task::spawn_blocking(move || detect_processes(&jc, &js))
        .await
        .unwrap_or_default();
    log::info!("DetectProcesses: returning {} processes", processes.len());
    for p in &processes {
        log::info!(
            "  - pane={} provider={} cmd_version={} session={} window={} group={:?} job={:?} cwd={}",
            p.pane_id, p.provider, p.version, p.tmux_session, p.window_name,
            p.matched_group, p.matched_job, p.cwd
        );
    }
    DesktopMessage::DetectedProcesses { id, processes }
}

fn handle_get_settings(
    id: String,
    settings: &Arc<Mutex<crate::config::settings::AppSettings>>,
) -> DesktopMessage {
    let s = settings.lock();
    let enabled_models: HashMap<String, Vec<String>> = s.enabled_models.clone();
    let default_provider = s.default_provider.as_str().to_string();
    let default_model = s.default_model.clone();
    DesktopMessage::SettingsResponse {
        id,
        enabled_models,
        default_provider,
        default_model,
    }
}

fn handle_set_auto_yes_panes(
    pane_ids: Vec<String>,
    auto_yes_panes: &Arc<Mutex<std::collections::HashSet<String>>>,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
    event_sink: &dyn EventSink,
) {
    log::info!("[handler] SetAutoYesPanes received: {:?}", pane_ids);
    let pane_set: std::collections::HashSet<String> = pane_ids.iter().cloned().collect();
    *auto_yes_panes.lock() = pane_set;
    event_sink.emit_auto_yes_changed();
    let msg = DesktopMessage::AutoYesPanes { pane_ids };
    let guard = relay.lock();
    if let Some(handle) = guard.as_ref() {
        handle.send_message(&msg);
    }
}

fn handle_subscribe_pty(
    id: String,
    pane_id: String,
    tmux_session: String,
    cols: u32,
    rows: u32,
    pty_manager: &SharedPtyManager,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
) -> DesktopMessage {
    let relay_for_pty = Arc::clone(relay);
    let (tx, rx) = std::sync::mpsc::channel::<(String, Vec<u8>)>();
    let result = pty_manager.lock().spawn(
        &pane_id,
        &tmux_session,
        cols as u16,
        rows as u16,
        "default",
        OutputSink::Channel(tx),
    );
    if result.is_ok() {
        let pane_id_clone = pane_id.clone();
        std::thread::spawn(move || {
            while let Ok((pid, data)) = rx.recv() {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
                let msg = DesktopMessage::PtyOutput {
                    pane_id: pid,
                    data: encoded,
                };
                let guard = relay_for_pty.lock();
                if let Some(handle) = guard.as_ref() {
                    handle.send_message(&msg);
                }
            }
            log::debug!("PTY relay forwarder exited for {}", pane_id_clone);
        });
    }
    DesktopMessage::SubscribePtyAck {
        id,
        success: result.is_ok(),
    }
}

fn run_job(
    name: &str,
    params: &HashMap<String, String>,
    trigger_id: Option<String>,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &JobContext,
) -> Result<(), String> {
    let job = {
        let config = jobs_config.lock();
        config
            .jobs
            .iter()
            .find(|j| j.slug == name)
            .cloned()
            .ok_or_else(|| format!("job not found: {}", name))?
    };

    let ctx = ctx.clone();
    let params = params.clone();
    let trigger = if trigger_id.is_some() {
        "trigger"
    } else {
        "remote"
    };

    tokio::spawn(async move {
        crate::scheduler::executor::execute_job(
            &job,
            &ctx,
            trigger,
            &params,
            crate::scheduler::executor::ExecuteOpts {
                trigger_id,
                ..Default::default()
            },
        )
        .await;
    });

    Ok(())
}

fn pause_job(
    name: &str,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Result<(), String> {
    let mut status = job_status.lock();
    match status.get(name) {
        Some(JobStatus::Running { .. }) => {
            status.insert(name.to_string(), JobStatus::Paused);
            Ok(())
        }
        _ => Err("job is not running".to_string()),
    }
}

fn resume_job(
    name: &str,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Result<(), String> {
    let mut status = job_status.lock();
    match status.get(name) {
        Some(JobStatus::Paused) => {
            status.insert(name.to_string(), JobStatus::Idle);
            Ok(())
        }
        _ => Err("job is not paused".to_string()),
    }
}

fn stop_job(
    name: &str,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
) -> Result<(), String> {
    let mut status = job_status.lock();
    match status.get(name).cloned() {
        Some(JobStatus::Running {
            pane_id: Some(pane_id),
            ..
        }) => {
            let _ = crate::tmux::kill_pane(&pane_id);
            let next_status = JobStatus::Idle;
            status.insert(name.to_string(), next_status.clone());
            drop(status);
            crate::relay::push_status_update(relay, name, &next_status);
            Ok(())
        }
        Some(JobStatus::Running { .. }) | Some(JobStatus::Paused) => {
            let next_status = JobStatus::Idle;
            status.insert(name.to_string(), next_status.clone());
            drop(status);
            crate::relay::push_status_update(relay, name, &next_status);
            Ok(())
        }
        _ => Err("job is not running".to_string()),
    }
}

fn send_input(
    name: &str,
    text: &str,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Result<(), String> {
    let statuses = job_status.lock();
    match statuses.get(name) {
        Some(JobStatus::Running {
            pane_id: Some(pane_id),
            ..
        }) => crate::tmux::send_keys_to_tui_pane(pane_id, text),
        Some(JobStatus::Running { .. }) => Err("job has no tmux pane".to_string()),
        _ => Err("job is not running".to_string()),
    }
}

fn send_input_freetext(
    name: &str,
    keystroke: &str,
    freetext: &str,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Result<(), String> {
    let statuses = job_status.lock();
    match statuses.get(name) {
        Some(JobStatus::Running {
            pane_id: Some(pane_id),
            ..
        }) => crate::tmux::send_keys_to_tui_pane_freetext(pane_id, keystroke, freetext),
        Some(JobStatus::Running { .. }) => Err("job has no tmux pane".to_string()),
        _ => Err("job is not running".to_string()),
    }
}

fn get_run_history(
    name: &str,
    limit: u32,
    history: &Arc<Mutex<HistoryStore>>,
) -> Vec<clawtab_protocol::RunRecord> {
    let h = history.lock();
    match h.get_by_job_id(name, limit as usize) {
        Ok(runs) => runs
            .into_iter()
            .map(|r| clawtab_protocol::RunRecord {
                id: r.id,
                job_id: r.job_id,
                started_at: r.started_at,
                finished_at: r.finished_at,
                exit_code: r.exit_code,
                trigger: r.trigger,
            })
            .collect(),
        Err(e) => {
            log::error!("Failed to get run history for {}: {}", name, e);
            vec![]
        }
    }
}

fn run_agent(
    prompt: &str,
    work_dir: Option<&str>,
    trigger_id: Option<String>,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &JobContext,
) -> Result<String, String> {
    let (s, jobs) = {
        let s = ctx.settings.lock().clone();
        let j = jobs_config.lock().jobs.clone();
        (s, j)
    };
    let job = crate::agent::build_agent_job(prompt, None, &s, &jobs, work_dir, None, None)?;
    let job_id = job.name.clone();

    let ctx = ctx.clone();
    let trigger = if trigger_id.is_some() {
        "trigger"
    } else {
        "remote"
    };

    tokio::spawn(async move {
        crate::scheduler::executor::execute_job(
            &job,
            &ctx,
            trigger,
            &HashMap::new(),
            crate::scheduler::executor::ExecuteOpts {
                trigger_id,
                ..Default::default()
            },
        )
        .await;
    });

    Ok(job_id)
}

fn create_job() -> Result<(), String> {
    // TODO: implement remote job creation
    Err("remote job creation not yet implemented".to_string())
}

fn get_run_detail_full(
    run_id: &str,
    history: &Arc<Mutex<HistoryStore>>,
) -> Option<clawtab_protocol::RunDetail> {
    let h = history.lock();
    match h.get_by_id(run_id) {
        Ok(Some(r)) => Some(clawtab_protocol::RunDetail {
            id: r.id,
            job_id: r.job_id,
            started_at: r.started_at,
            finished_at: r.finished_at,
            exit_code: r.exit_code,
            trigger: r.trigger,
            stdout: r.stdout,
            stderr: r.stderr,
        }),
        _ => None,
    }
}

fn dp_is_semver(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn dp_is_view_session(name: &str) -> bool {
    name.starts_with("clawtab-") && name.contains("-view-")
}

fn dp_normalize_optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn dp_list_panes() -> Option<String> {
    let output = crate::debug_spawn::run_logged(
        "tmux",
        &[
            "list-panes", "-a", "-F",
            "#{pane_id}\x1e#{pane_current_command}\x1e#{pane_current_path}\x1e#{session_name}\x1e#{window_name}\x1e#{pane_pid}\x1e#{window_id}\x1e#{pane_title}\x1e#{@clawtab-slug}",
        ],
        "relay::list_panes_snapshot",
    );
    match output {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).to_string()),
        Ok(o) => {
            log::warn!(
                "detect_processes: tmux list-panes exited {:?}: stderr={}",
                o.status.code(),
                String::from_utf8_lossy(&o.stderr)
            );
            None
        }
        Err(e) => {
            log::warn!("detect_processes: tmux list-panes spawn error: {}", e);
            None
        }
    }
}

fn dp_collect_running_panes(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> HashMap<String, (String, String)> {
    let config = jobs_config.lock();
    let statuses = job_status.lock();
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

fn dp_collect_slug_to_group(jobs_config: &Arc<Mutex<JobsConfig>>) -> HashMap<String, String> {
    let config = jobs_config.lock();
    config
        .jobs
        .iter()
        .map(|job| (job.slug.clone(), job.group.clone()))
        .collect()
}

fn dp_collect_match_entries(jobs_config: &Arc<Mutex<JobsConfig>>) -> Vec<(String, String, String)> {
    let config = jobs_config.lock();
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

struct DpRow<'a> {
    pane_id: &'a str,
    command: &'a str,
    cwd: &'a str,
    session: &'a str,
    window: &'a str,
    pane_pid: &'a str,
    pane_title: Option<String>,
    pane_slug_tag: Option<String>,
}

#[derive(Default)]
struct DpSkipCounters {
    short: u32,
    view: u32,
    placeholder: u32,
}

fn dp_parse_row(line: &str) -> Option<DpRow<'_>> {
    let parts: Vec<&str> = line.splitn(9, '\x1e').collect();
    if parts.len() < 8 {
        return None;
    }
    Some(DpRow {
        pane_id: parts[0],
        command: parts[1],
        cwd: parts[2],
        session: parts[3],
        window: parts[4],
        pane_pid: parts[5],
        pane_title: dp_normalize_optional_text(parts[7].to_string()),
        pane_slug_tag: parts
            .get(8)
            .and_then(|s| dp_normalize_optional_text((*s).to_string())),
    })
}

fn dp_resolve_provider(row: &DpRow<'_>) -> Option<crate::agent_session::ProcessProvider> {
    let agent_provider =
        crate::agent_session::detect_process_provider(row.pane_pid, None).or_else(|| {
            dp_is_semver(row.command).then_some(crate::agent_session::ProcessProvider::Claude)
        });
    let is_clawtab_shell_window =
        row.window.starts_with("ct-clawtab-shell-") || row.window.starts_with("clawtab-shell-");
    match (agent_provider, is_clawtab_shell_window) {
        (Some(p), _) => Some(p),
        (None, true) => Some(crate::agent_session::ProcessProvider::Shell),
        (None, false) => None,
    }
}

fn dp_resolve_group_job(
    row: &DpRow<'_>,
    running_panes: &HashMap<String, (String, String)>,
    slug_to_group: &HashMap<String, String>,
    match_entries: &[(String, String, String)],
) -> (Option<String>, Option<String>) {
    if let Some((group, slug)) = running_panes.get(row.pane_id) {
        return (Some(group.clone()), Some(slug.clone()));
    }
    if let Some(group) = row
        .pane_slug_tag
        .as_ref()
        .and_then(|tag| slug_to_group.get(tag))
    {
        return (Some(group.clone()), row.pane_slug_tag.clone());
    }
    let best = match_entries
        .iter()
        .filter(|(root, _, _)| row.cwd == root || row.cwd.starts_with(&format!("{}/", root)))
        .max_by_key(|(root, _, _)| root.len());
    match best {
        Some((_, group, _)) => (Some(group.clone()), None),
        None => (None, None),
    }
}

fn dp_build_remote(
    row: &DpRow<'_>,
    provider: crate::agent_session::ProcessProvider,
    matched_group: Option<String>,
    matched_job: Option<String>,
) -> RemoteDetectedProcess {
    let log_lines = crate::tmux::capture_pane(row.session, row.pane_id, 5)
        .unwrap_or_default()
        .trim()
        .to_string();
    let session_info = crate::agent_session::resolve_session_info_for_provider_with_cwd(
        row.pane_pid,
        Some(provider),
        None,
        Some(row.cwd),
    );
    let (can_fork_session, can_send_skills, can_inject_secrets) = match provider {
        crate::agent_session::ProcessProvider::Claude => (true, true, true),
        _ => (false, false, false),
    };
    let display_window = row
        .pane_title
        .clone()
        .unwrap_or_else(|| row.window.to_string());

    RemoteDetectedProcess {
        pane_id: row.pane_id.to_string(),
        cwd: row.cwd.to_string(),
        version: if dp_is_semver(row.command) {
            row.command.to_string()
        } else {
            String::new()
        },
        provider: provider.as_str().to_string(),
        can_fork_session,
        can_send_skills,
        can_inject_secrets,
        tmux_session: row.session.to_string(),
        window_name: display_window,
        matched_group,
        matched_job,
        log_lines,
        first_query: session_info.first_query,
        last_query: session_info.last_query,
        session_started_at: session_info.session_started_at,
        token_count: session_info.token_count,
    }
}

fn detect_processes(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Vec<RemoteDetectedProcess> {
    use std::collections::HashSet;

    let Some(stdout) = dp_list_panes() else {
        return vec![];
    };
    let pane_lines = stdout.lines().count();
    if pane_lines > 0 {
        let first = stdout.lines().next().unwrap_or("");
        let hex: String = first
            .bytes()
            .take(80)
            .map(|b| format!("{:02x} ", b))
            .collect();
        log::info!(
            "detect_processes: tmux returned {} pane lines. first_line_hex(80)={}",
            pane_lines,
            hex
        );
    } else {
        log::info!("detect_processes: tmux returned 0 pane lines");
    }

    let running_panes = dp_collect_running_panes(jobs_config, job_status);
    let slug_to_group = dp_collect_slug_to_group(jobs_config);
    let match_entries = dp_collect_match_entries(jobs_config);

    let mut seen = HashSet::new();
    let mut results = Vec::new();
    let mut counters = DpSkipCounters::default();

    for line in stdout.lines() {
        let Some(row) = dp_parse_row(line) else {
            counters.short += 1;
            continue;
        };
        if dp_is_view_session(row.session) {
            counters.view += 1;
            continue;
        }
        if row.window == "__placeholder" {
            counters.placeholder += 1;
            continue;
        }
        let Some(provider) = dp_resolve_provider(&row) else {
            continue;
        };
        if !seen.insert(row.pane_id.to_string()) {
            continue;
        }
        let (matched_group, matched_job) =
            dp_resolve_group_job(&row, &running_panes, &slug_to_group, &match_entries);
        results.push(dp_build_remote(&row, provider, matched_group, matched_job));
    }

    log::info!(
        "detect_processes: summary: total_lines={} skipped_short={} skipped_view={} skipped_placeholder={} kept={}",
        pane_lines, counters.short, counters.view, counters.placeholder, results.len()
    );

    results
}
