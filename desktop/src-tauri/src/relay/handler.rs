use base64::Engine;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use clawtab_protocol::{ClientMessage, DesktopMessage, JobStatus as RemoteJobStatus, RemoteJob};

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
            let processes = crate::process_snapshot::detect_processes_snapshot(
                jobs_config,
                &ctx.job_status,
                pty_manager,
            )
            .await;
            Some(DesktopMessage::DetectedProcesses { id, processes })
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
        ClientMessage::TmuxPaneKey { pane_id, key } => {
            let result = if key == "copy-halfpage-up" || key == "copy-halfpage-down" {
                let command = if key == "copy-halfpage-up" {
                    "halfpage-up"
                } else {
                    "halfpage-down"
                };
                crate::tmux::enter_copy_mode(&pane_id)
                    .and_then(|_| crate::tmux::send_copy_mode_command_to_pane(&pane_id, command))
            } else if key == "copy-mode" {
                crate::tmux::enter_copy_mode(&pane_id)
            } else {
                crate::tmux::send_key_to_pane(&pane_id, &key)
            };
            if let Err(e) = result {
                log::warn!(
                    "Relay: failed to send tmux pane key {} to {}: {}",
                    key,
                    pane_id,
                    e
                );
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
        Some(JobStatus::Running { .. }) => {
            drop(status);
            match crate::scheduler::executor::binary_runtime::stop(name) {
                Ok(true) => {
                    let next_status = JobStatus::Idle;
                    job_status
                        .lock()
                        .insert(name.to_string(), next_status.clone());
                    crate::relay::push_status_update(relay, name, &next_status);
                    Ok(())
                }
                Ok(false) => Err("job has no tracked process".to_string()),
                Err(e) => Err(e),
            }
        }
        Some(JobStatus::Paused) => {
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
