use base64::Engine;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use clawtab_protocol::{
    ClientMessage, DesktopMessage, DetectedProcess as RemoteDetectedProcess,
    JobStatus as RemoteJobStatus, RemoteJob,
};

use crate::config::jobs::{JobStatus, JobsConfig};
use crate::events::EventSink;
use crate::config::settings::AppSettings;
use crate::history::HistoryStore;
use crate::secrets::SecretsManager;
use crate::telegram::ActiveAgent;

use crate::pty::{OutputSink, SharedPtyManager};

use super::{job_to_remote, status_to_remote, RelayHandle};

/// Handle a message received from the relay server (forwarded from a mobile client).
/// Returns a JSON response string to send back, or None.
pub async fn handle_incoming(
    text: &str,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    secrets: &Arc<Mutex<SecretsManager>>,
    history: &Arc<Mutex<HistoryStore>>,
    settings: &Arc<Mutex<AppSettings>>,
    active_agents: &Arc<Mutex<HashMap<i64, ActiveAgent>>>,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
    auto_yes_panes: &Arc<Mutex<std::collections::HashSet<String>>>,
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

    let response = match msg {
        ClientMessage::ListJobs { id } => {
            let jobs = jobs_config.lock().unwrap().jobs.clone();
            let statuses = job_status.lock().unwrap().clone();
            let remote_jobs: Vec<RemoteJob> = jobs.iter().map(job_to_remote).collect();
            let remote_statuses: HashMap<String, RemoteJobStatus> = statuses
                .into_iter()
                .map(|(k, v)| (k, status_to_remote(&v)))
                .collect();
            Some(DesktopMessage::JobsList {
                id,
                jobs: remote_jobs,
                statuses: remote_statuses,
            })
        }

        ClientMessage::RunJob { id, name, params } => {
            let result = run_job(
                &name,
                &params,
                jobs_config,
                secrets,
                history,
                settings,
                job_status,
                active_agents,
                relay,
            );
            event_sink.emit_jobs_changed();
            Some(DesktopMessage::RunJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::PauseJob { id, name } => {
            let result = pause_job(&name, job_status);
            event_sink.emit_jobs_changed();
            Some(DesktopMessage::PauseJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::ResumeJob { id, name } => {
            let result = resume_job(&name, job_status);
            event_sink.emit_jobs_changed();
            Some(DesktopMessage::ResumeJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::StopJob { id, name } => {
            let result = stop_job(&name, job_status, relay);
            event_sink.emit_jobs_changed();
            Some(DesktopMessage::StopJobAck {
                id,
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
            let result = if let Some(ref ft) = freetext {
                send_input_freetext(&name, &text, ft, job_status)
            } else {
                send_input(&name, &text, job_status)
            };
            Some(DesktopMessage::SendInputAck {
                id,
                success: result.is_ok(),
            })
        }

        ClientMessage::SubscribeLogs { id, name } => {
            // Send current pane content as initial log chunk so mobile gets existing logs
            let statuses = job_status.lock().unwrap();
            if let Some(JobStatus::Running {
                pane_id: Some(pane_id),
                tmux_session: Some(session),
                ..
            }) = statuses.get(&name)
            {
                if let Ok(content) = crate::tmux::capture_pane(session, pane_id, 200) {
                    let content = content.trim().to_string();
                    if !content.is_empty() {
                        super::push_log_chunk(relay, &name, &content);
                    }
                }
            }
            drop(statuses);
            Some(DesktopMessage::SubscribeLogsAck { id, success: true })
        }

        ClientMessage::UnsubscribeLogs { .. } => None,

        ClientMessage::GetRunHistory { id, name, limit } => {
            let runs = get_run_history(&name, limit, history);
            Some(DesktopMessage::RunHistory { id, runs })
        }

        ClientMessage::RunAgent {
            id,
            prompt,
            work_dir,
        } => {
            let result = run_agent(
                &prompt,
                work_dir.as_deref(),
                jobs_config,
                secrets,
                history,
                settings,
                job_status,
                active_agents,
                relay,
            );
            Some(DesktopMessage::RunAgentAck {
                id,
                success: result.is_ok(),
                job_id: result.ok(),
            })
        }

        ClientMessage::CreateJob {
            id,
            name,
            job_type,
            path,
            prompt,
            cron,
            group,
        } => {
            let result = create_job(
                &name,
                &job_type,
                &path,
                &prompt,
                &cron,
                &group,
                jobs_config,
                settings,
            );
            if result.is_ok() {
                event_sink.emit_jobs_changed();
            }
            Some(DesktopMessage::CreateJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::DetectProcesses { id } => {
            let jc = Arc::clone(jobs_config);
            let js = Arc::clone(job_status);
            let processes = tokio::task::spawn_blocking(move || detect_processes(&jc, &js))
                .await
                .unwrap_or_default();
            Some(DesktopMessage::DetectedProcesses { id, processes })
        }

        ClientMessage::GetSettings { id } => {
            let s = settings.lock().unwrap();
            let enabled_models: HashMap<String, Vec<String>> = s.enabled_models.clone();
            let default_provider = s.default_provider.as_str().to_string();
            let default_model = s.default_model.clone();
            Some(DesktopMessage::SettingsResponse {
                id,
                enabled_models,
                default_provider,
                default_model,
            })
        }

        ClientMessage::GetRunDetail { id, run_id } => {
            let detail = get_run_detail_full(&run_id, history);
            Some(DesktopMessage::RunDetailResponse { id, detail })
        }

        ClientMessage::GetDetectedProcessLogs {
            id,
            tmux_session,
            pane_id,
        } => {
            let logs = crate::tmux::capture_pane(&tmux_session, &pane_id, 200).unwrap_or_default();
            Some(DesktopMessage::DetectedProcessLogs { id, logs })
        }

        ClientMessage::SendDetectedProcessInput { id, pane_id, text } => {
            let result = crate::tmux::send_keys_to_tui_pane(&pane_id, &text);
            Some(DesktopMessage::SendDetectedProcessInputAck {
                id,
                success: result.is_ok(),
            })
        }

        ClientMessage::StopDetectedProcess { id, pane_id } => {
            let result = crate::tmux::kill_pane(&pane_id);
            Some(DesktopMessage::StopDetectedProcessAck {
                id,
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
            let result = if let Some(ref text) = freetext {
                crate::tmux::send_keys_to_tui_pane_freetext(&pane_id, &answer, text)
            } else {
                crate::tmux::send_keys_to_tui_pane(&pane_id, &answer)
            };
            Some(DesktopMessage::SendDetectedProcessInputAck {
                id,
                success: result.is_ok(),
            })
        }

        ClientMessage::SetAutoYesPanes { pane_ids, .. } => {
            log::info!("[handler] SetAutoYesPanes received: {:?}", pane_ids);
            let pane_set: std::collections::HashSet<String> = pane_ids.iter().cloned().collect();
            *auto_yes_panes.lock().unwrap() = pane_set;
            event_sink.emit_auto_yes_changed();
            // Broadcast back to relay so it updates its cache and forwards to all mobiles
            let msg = DesktopMessage::AutoYesPanes { pane_ids };
            if let Ok(guard) = relay.lock() {
                if let Some(handle) = guard.as_ref() {
                    handle.send_message(&msg);
                }
            }
            None
        }

        ClientMessage::SubscribePty {
            id,
            pane_id,
            tmux_session,
            cols,
            rows,
        } => {
            let relay_for_pty = Arc::clone(relay);
            let (tx, rx) = std::sync::mpsc::channel::<(String, Vec<u8>)>();
            let result = pty_manager.lock().unwrap().spawn(
                &pane_id,
                &tmux_session,
                cols as u16,
                rows as u16,
                "default",
                OutputSink::Channel(tx),
            );
            if result.is_ok() {
                // Spawn a thread that reads PTY output from the channel and
                // forwards it to the relay as PtyOutput messages
                let pane_id_clone = pane_id.clone();
                std::thread::spawn(move || {
                    while let Ok((pid, data)) = rx.recv() {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
                        let msg = DesktopMessage::PtyOutput {
                            pane_id: pid,
                            data: encoded,
                        };
                        if let Ok(guard) = relay_for_pty.lock() {
                            if let Some(handle) = guard.as_ref() {
                                handle.send_message(&msg);
                            }
                        }
                    }
                    log::debug!("PTY relay forwarder exited for {}", pane_id_clone);
                });
            }
            Some(DesktopMessage::SubscribePtyAck {
                id,
                success: result.is_ok(),
            })
        }

        ClientMessage::UnsubscribePty { pane_id } => {
            let _ = pty_manager.lock().unwrap().destroy(&pane_id, None);
            None
        }

        ClientMessage::PtyInput { pane_id, data } => {
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&data) {
                let _ = pty_manager.lock().unwrap().write(&pane_id, &bytes);
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
                .unwrap()
                .resize(&pane_id, cols as u16, rows as u16);
            None
        }

        // These are handled by the relay server, never forwarded to desktop
        ClientMessage::RegisterPushToken { .. } | ClientMessage::GetNotificationHistory { .. } => {
            None
        }
    };

    match response {
        Some(resp) => match serde_json::to_string(&resp) {
            Ok(json) => {
                log::debug!("Relay response: {}", &json[..json.len().min(200)]);
                Some(json)
            }
            Err(e) => {
                log::error!("Failed to serialize relay response: {}", e);
                None
            }
        },
        None => None,
    }
}

fn run_job(
    name: &str,
    params: &HashMap<String, String>,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    secrets: &Arc<Mutex<SecretsManager>>,
    history: &Arc<Mutex<HistoryStore>>,
    settings: &Arc<Mutex<AppSettings>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    active_agents: &Arc<Mutex<HashMap<i64, ActiveAgent>>>,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
) -> Result<(), String> {
    let job = {
        let config = jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .find(|j| j.slug == name)
            .cloned()
            .ok_or_else(|| format!("job not found: {}", name))?
    };

    let secrets = Arc::clone(secrets);
    let history = Arc::clone(history);
    let settings = Arc::clone(settings);
    let job_status = Arc::clone(job_status);
    let active_agents = Arc::clone(active_agents);
    let relay = Arc::clone(relay);
    let params = params.clone();

    tokio::spawn(async move {
        crate::scheduler::executor::execute_job(
            &job,
            &secrets,
            &history,
            &settings,
            &job_status,
            "remote",
            &active_agents,
            &relay,
            &params,
            None,
        )
        .await;
    });

    Ok(())
}

fn pause_job(
    name: &str,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Result<(), String> {
    let mut status = job_status.lock().unwrap();
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
    let mut status = job_status.lock().unwrap();
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
    let mut status = job_status.lock().unwrap();
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
    let statuses = job_status.lock().unwrap();
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
    let statuses = job_status.lock().unwrap();
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
    let h = history.lock().unwrap();
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
    jobs_config: &Arc<Mutex<JobsConfig>>,
    secrets: &Arc<Mutex<SecretsManager>>,
    history: &Arc<Mutex<HistoryStore>>,
    settings: &Arc<Mutex<AppSettings>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    active_agents: &Arc<Mutex<HashMap<i64, ActiveAgent>>>,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
) -> Result<String, String> {
    let (s, jobs) = {
        let s = settings.lock().unwrap().clone();
        let j = jobs_config.lock().unwrap().jobs.clone();
        (s, j)
    };
    let job = crate::agent::build_agent_job(prompt, None, &s, &jobs, work_dir, None, None)?;
    let job_id = job.name.clone();

    let secrets = Arc::clone(secrets);
    let history = Arc::clone(history);
    let settings = Arc::clone(settings);
    let job_status = Arc::clone(job_status);
    let active_agents = Arc::clone(active_agents);
    let relay = Arc::clone(relay);

    tokio::spawn(async move {
        crate::scheduler::executor::execute_job(
            &job,
            &secrets,
            &history,
            &settings,
            &job_status,
            "remote",
            &active_agents,
            &relay,
            &HashMap::new(),
            None,
        )
        .await;
    });

    Ok(job_id)
}

fn create_job(
    _name: &str,
    _job_type: &str,
    _path: &str,
    _prompt: &str,
    _cron: &str,
    _group: &str,
    _jobs_config: &Arc<Mutex<JobsConfig>>,
    _settings: &Arc<Mutex<AppSettings>>,
) -> Result<(), String> {
    // TODO: implement remote job creation
    Err("remote job creation not yet implemented".to_string())
}

fn get_run_detail_full(
    run_id: &str,
    history: &Arc<Mutex<HistoryStore>>,
) -> Option<clawtab_protocol::RunDetail> {
    let h = history.lock().unwrap();
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

fn detect_processes(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> Vec<RemoteDetectedProcess> {
    use std::collections::HashSet;

    fn is_semver(s: &str) -> bool {
        let parts: Vec<&str> = s.split('.').collect();
        parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    }

    fn is_view_session(name: &str) -> bool {
        name.starts_with("clawtab-") && name.contains("-view-")
    }

    let output = match crate::debug_spawn::run_logged(
        "tmux",
        &[
            "list-panes", "-a", "-F",
            "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}\t#{window_name}\t#{pane_pid}",
        ],
        "relay::list_panes_snapshot",
    ) {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    let tracked_panes: HashSet<String> = {
        let statuses = job_status.lock().unwrap();
        statuses
            .values()
            .filter_map(|s| match s {
                JobStatus::Running {
                    pane_id: Some(pid), ..
                } => Some(pid.clone()),
                _ => None,
            })
            .collect()
    };

    let match_entries: Vec<(String, String, String)> = {
        let config = jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .filter_map(|job| {
                if let Some(ref fp) = job.folder_path {
                    Some((fp.clone(), job.group.clone(), job.name.clone()))
                } else if let Some(ref wd) = job.work_dir {
                    Some((wd.clone(), job.group.clone(), job.name.clone()))
                } else {
                    None
                }
            })
            .collect()
    };

    let mut seen = HashSet::new();
    let mut results = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(6, '\t').collect();
        if parts.len() < 6 {
            continue;
        }

        let (pane_id, command, cwd, session, window, pane_pid) =
            (parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);
        if is_view_session(session) {
            continue;
        }

        let provider =
            crate::agent_session::detect_process_provider(pane_pid, None).or_else(|| {
                is_semver(command).then_some(crate::agent_session::ProcessProvider::Claude)
            });
        let Some(provider) = provider else {
            continue;
        };
        if !seen.insert(pane_id.to_string()) {
            continue;
        }
        if tracked_panes.contains(pane_id) {
            continue;
        }

        let mut matched_group = None;
        let matched_job = None;
        for (root, group, _name) in &match_entries {
            if cwd == root || cwd.starts_with(&format!("{}/", root)) {
                matched_group = Some(group.clone());
                break;
            }
        }

        let log_lines = crate::tmux::capture_pane(session, pane_id, 5)
            .unwrap_or_default()
            .trim()
            .to_string();

        let session_info = crate::agent_session::resolve_session_info_for_provider_with_cwd(
            pane_pid,
            Some(provider),
            None,
            Some(cwd),
        );
        let (can_fork_session, can_send_skills, can_inject_secrets) = match provider {
            crate::agent_session::ProcessProvider::Claude => (true, true, true),
            crate::agent_session::ProcessProvider::Codex => (false, false, false),
            crate::agent_session::ProcessProvider::Opencode => (false, false, false),
            crate::agent_session::ProcessProvider::Shell => (false, false, false),
        };

        results.push(RemoteDetectedProcess {
            pane_id: pane_id.to_string(),
            cwd: cwd.to_string(),
            version: if is_semver(command) {
                command.to_string()
            } else {
                String::new()
            },
            provider: provider.as_str().to_string(),
            can_fork_session,
            can_send_skills,
            can_inject_secrets,
            tmux_session: session.to_string(),
            window_name: window.to_string(),
            matched_group,
            matched_job,
            log_lines,
            first_query: session_info.first_query,
            last_query: session_info.last_query,
            session_started_at: session_info.session_started_at,
        });
    }

    results
}
