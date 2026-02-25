use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use clawtab_protocol::{ClientMessage, DesktopMessage, JobStatus as RemoteJobStatus, RemoteJob};

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

        ClientMessage::RunJob { id, name } => {
            let result = run_job(
                &name,
                jobs_config,
                secrets,
                history,
                settings,
                job_status,
                active_agents,
                relay,
            );
            Some(DesktopMessage::RunJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::PauseJob { id, name } => {
            let result = pause_job(&name, job_status);
            Some(DesktopMessage::PauseJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::ResumeJob { id, name } => {
            let result = resume_job(&name, job_status);
            Some(DesktopMessage::ResumeJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
        }

        ClientMessage::StopJob { id, name } => {
            let result = stop_job(&name, job_status);
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

        ClientMessage::SubscribeLogs { id, name: _ } => Some(DesktopMessage::SubscribeLogsAck {
            id,
            success: true,
        }),

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
            Some(DesktopMessage::CreateJobAck {
                id,
                success: result.is_ok(),
                error: result.err(),
            })
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
    _prompt: &str,
    _jobs_config: &Arc<Mutex<JobsConfig>>,
    _secrets: &Arc<Mutex<SecretsManager>>,
    _history: &Arc<Mutex<HistoryStore>>,
    _settings: &Arc<Mutex<AppSettings>>,
    _job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    _active_agents: &Arc<Mutex<HashMap<i64, ActiveAgent>>>,
) -> Result<String, String> {
    // TODO: implement agent run via relay
    Err("agent run via relay not yet implemented".to_string())
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
