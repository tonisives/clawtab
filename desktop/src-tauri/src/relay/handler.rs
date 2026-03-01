use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use clawtab_protocol::{
    ClaudeProcess as RemoteClaudeProcess, ClientMessage, DesktopMessage,
    JobStatus as RemoteJobStatus, RemoteJob,
};

use tauri::Emitter;

use crate::config::jobs::{JobStatus, JobsConfig};
use crate::config::settings::AppSettings;
use crate::history::HistoryStore;
use crate::secrets::SecretsManager;
use crate::telegram::ActiveAgent;

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
    app_handle: &tauri::AppHandle,
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
            let _ = app_handle.emit("jobs-changed", ());
            Some(DesktopMessage::RunJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::PauseJob { id, name } => {
            let result = pause_job(&name, job_status);
            let _ = app_handle.emit("jobs-changed", ());
            Some(DesktopMessage::PauseJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::ResumeJob { id, name } => {
            let result = resume_job(&name, job_status);
            let _ = app_handle.emit("jobs-changed", ());
            Some(DesktopMessage::ResumeJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::StopJob { id, name } => {
            let result = stop_job(&name, job_status);
            let _ = app_handle.emit("jobs-changed", ());
            Some(DesktopMessage::StopJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::SendInput { id, name, text } => {
            let result = send_input(&name, &text, job_status);
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

        ClientMessage::RunAgent { id, prompt } => {
            let result = run_agent(
                &prompt,
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
                job_name: result.ok(),
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
                &name, &job_type, &path, &prompt, &cron, &group, jobs_config, settings,
            );
            if result.is_ok() {
                let _ = app_handle.emit("jobs-changed", ());
            }
            Some(DesktopMessage::CreateJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::DetectProcesses { id } => {
            let processes = detect_processes(jobs_config, job_status);
            Some(DesktopMessage::DetectedProcesses { id, processes })
        }

        ClientMessage::GetRunDetail { id, run_id } => {
            let detail = get_run_detail_full(&run_id, history);
            Some(DesktopMessage::RunDetailResponse { id, detail })
        }

        ClientMessage::GetDetectedProcessLogs { id, tmux_session, pane_id } => {
            let logs = crate::tmux::capture_pane(&tmux_session, &pane_id, 200)
                .unwrap_or_default();
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

        ClientMessage::AnswerQuestion { id, pane_id, answer, .. } => {
            let result = crate::tmux::send_keys_to_tui_pane(&pane_id, &answer);
            Some(DesktopMessage::SendDetectedProcessInputAck {
                id,
                success: result.is_ok(),
            })
        }

        ClientMessage::SetAutoYesPanes { pane_ids, .. } => {
            let pane_set: std::collections::HashSet<String> = pane_ids.iter().cloned().collect();
            *auto_yes_panes.lock().unwrap() = pane_set;
            let _ = app_handle.emit("auto-yes-changed", ());
            // Broadcast back to relay so it updates its cache and forwards to all mobiles
            let msg = DesktopMessage::AutoYesPanes { pane_ids };
            if let Ok(guard) = relay.lock() {
                if let Some(handle) = guard.as_ref() {
                    handle.send_message(&msg);
                }
            }
            None
        }

        // These are handled by the relay server, never forwarded to desktop
        ClientMessage::RegisterPushToken { .. }
        | ClientMessage::GetNotificationHistory { .. } => None,
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
            .find(|j| j.name == name)
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
) -> Result<(), String> {
    let mut status = job_status.lock().unwrap();
    match status.get(name).cloned() {
        Some(JobStatus::Running {
            pane_id: Some(pane_id),
            ..
        }) => {
            let _ = crate::tmux::kill_pane(&pane_id);
            status.insert(name.to_string(), JobStatus::Idle);
            Ok(())
        }
        Some(JobStatus::Running { .. }) | Some(JobStatus::Paused) => {
            status.insert(name.to_string(), JobStatus::Idle);
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

fn get_run_history(
    name: &str,
    limit: u32,
    history: &Arc<Mutex<HistoryStore>>,
) -> Vec<clawtab_protocol::RunRecord> {
    let h = history.lock().unwrap();
    match h.get_by_job_name(name, limit as usize) {
        Ok(runs) => runs
            .into_iter()
            .map(|r| clawtab_protocol::RunRecord {
                id: r.id,
                job_name: r.job_name,
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
    let job = crate::commands::jobs::build_agent_job(prompt, None, &s, &jobs)?;
    let job_name = job.name.clone();

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
        )
        .await;
    });

    Ok(job_name)
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
            job_name: r.job_name,
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
) -> Vec<RemoteClaudeProcess> {
    use std::collections::HashSet;
    use std::process::Command;

    fn is_semver(s: &str) -> bool {
        let parts: Vec<&str> = s.split('.').collect();
        parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    }

    let output = match Command::new("tmux")
        .args([
            "list-panes", "-a", "-F",
            "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}\t#{window_name}",
        ])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    let tracked_panes: HashSet<String> = {
        let statuses = job_status.lock().unwrap();
        statuses.values().filter_map(|s| match s {
            JobStatus::Running { pane_id: Some(pid), .. } => Some(pid.clone()),
            _ => None,
        }).collect()
    };

    let match_entries: Vec<(String, String, String)> = {
        let config = jobs_config.lock().unwrap();
        config.jobs.iter().filter_map(|job| {
            if let Some(ref fp) = job.folder_path {
                let root = fp.strip_suffix("/.cwt").unwrap_or(fp);
                Some((root.to_string(), job.group.clone(), job.name.clone()))
            } else if let Some(ref wd) = job.work_dir {
                Some((wd.clone(), job.group.clone(), job.name.clone()))
            } else {
                None
            }
        }).collect()
    };

    let mut seen = HashSet::new();
    let mut results = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(5, '\t').collect();
        if parts.len() < 5 { continue; }

        let (pane_id, command, cwd, session, window) =
            (parts[0], parts[1], parts[2], parts[3], parts[4]);

        if !is_semver(command) { continue; }
        if !seen.insert(pane_id.to_string()) { continue; }
        if tracked_panes.contains(pane_id) { continue; }

        let mut matched_group = None;
        let matched_job = None;
        for (root, group, _name) in &match_entries {
            if cwd == root || cwd.starts_with(&format!("{}/", root)) {
                matched_group = Some(group.clone());
                break;
            }
        }

        let log_lines = crate::tmux::capture_pane(session, pane_id, 5)
            .unwrap_or_default().trim().to_string();

        results.push(RemoteClaudeProcess {
            pane_id: pane_id.to_string(),
            cwd: cwd.to_string(),
            version: command.to_string(),
            tmux_session: session.to_string(),
            window_name: window.to_string(),
            matched_group,
            matched_job,
            log_lines,
        });
    }

    results
}
