use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::config::jobs::{Job, JobStatus, JobsConfig};
use crate::config::settings::AppSettings;
use crate::history::HistoryStore;
use crate::secrets::SecretsManager;

use super::commands::{self, AgentCommand};
use super::types::{TelegramResponse, Update};
use super::TelegramConfig;

pub struct AgentState {
    pub settings: Arc<Mutex<AppSettings>>,
    pub jobs_config: Arc<Mutex<JobsConfig>>,
    pub secrets: Arc<Mutex<SecretsManager>>,
    pub history: Arc<Mutex<HistoryStore>>,
    pub job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
}

pub async fn start_polling(state: AgentState) {
    let mut offset: Option<i64> = None;

    loop {
        let config = {
            let s = state.settings.lock().unwrap();
            s.telegram.clone()
        };

        let config = match config {
            Some(c) if c.agent_enabled && c.is_configured() => c,
            _ => {
                // Agent not enabled or not configured, check again later
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                continue;
            }
        };

        // Yield to setup poller so it can detect new chat IDs
        if super::is_setup_polling() {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            continue;
        }

        match get_updates(&config.bot_token, offset).await {
            Ok(updates) => {
                for update in updates {
                    offset = Some(update.update_id + 1);

                    if let Some(ref message) = update.message {
                        // Check allowlist
                        if !config.chat_ids.contains(&message.chat.id) {
                            log::debug!(
                                "Ignoring message from unauthorized chat {}",
                                message.chat.id
                            );
                            continue;
                        }

                        if let Some(ref text) = message.text {
                            let response = handle_message(text, &config, &state).await;
                            if let Some(reply) = response {
                                if let Err(e) = super::send_message(
                                    &config.bot_token,
                                    message.chat.id,
                                    &reply,
                                )
                                .await
                                {
                                    log::error!("Failed to send reply: {}", e);
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("Telegram polling error: {}", e);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    }
}

async fn get_updates(bot_token: &str, offset: Option<i64>) -> Result<Vec<Update>, String> {
    let client = reqwest::Client::new();
    let url = format!("https://api.telegram.org/bot{}/getUpdates", bot_token);

    let mut params = serde_json::json!({
        "timeout": 30,
        "allowed_updates": ["message"],
    });

    if let Some(off) = offset {
        params["offset"] = serde_json::json!(off);
    }

    let resp = client
        .post(&url)
        .json(&params)
        .timeout(std::time::Duration::from_secs(35))
        .send()
        .await
        .map_err(|e| format!("Telegram request failed: {}", e))?;

    let body: TelegramResponse<Vec<Update>> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !body.ok {
        return Err("Telegram API returned not ok".to_string());
    }

    Ok(body.result.unwrap_or_default())
}

async fn handle_message(text: &str, _config: &TelegramConfig, state: &AgentState) -> Option<String> {
    let cmd = commands::parse_command(text)?;

    Some(match cmd {
        AgentCommand::Help => commands::format_help(),
        AgentCommand::Jobs => {
            let jobs: Vec<Job> = state.jobs_config.lock().unwrap().jobs.clone();
            commands::format_jobs(&jobs)
        }
        AgentCommand::Status => {
            let statuses = state.job_status.lock().unwrap().clone();
            commands::format_status(&statuses)
        }
        AgentCommand::Run(name) => {
            let job = {
                let config = state.jobs_config.lock().unwrap();
                config.jobs.iter().find(|j| j.name == name).cloned()
            };
            match job {
                Some(job) => {
                    let secrets = Arc::clone(&state.secrets);
                    let history = Arc::clone(&state.history);
                    let settings = Arc::clone(&state.settings);
                    let job_status = Arc::clone(&state.job_status);
                    tokio::spawn(async move {
                        crate::scheduler::executor::execute_job(
                            &job, &secrets, &history, &settings, &job_status, "telegram",
                        )
                        .await;
                    });
                    format!("Started job <code>{}</code>", name)
                }
                None => format!("Job not found: {}", name),
            }
        }
        AgentCommand::Pause(name) => {
            let mut status = state.job_status.lock().unwrap();
            match status.get(&name) {
                Some(JobStatus::Running { .. }) => {
                    status.insert(name.clone(), JobStatus::Paused);
                    format!("Paused job <code>{}</code>", name)
                }
                _ => format!("Job <code>{}</code> is not running", name),
            }
        }
        AgentCommand::Resume(name) => {
            let mut status = state.job_status.lock().unwrap();
            match status.get(&name) {
                Some(JobStatus::Paused) => {
                    status.insert(name.clone(), JobStatus::Idle);
                    format!("Resumed job <code>{}</code>", name)
                }
                _ => format!("Job <code>{}</code> is not paused", name),
            }
        }
        AgentCommand::Unknown(msg) => msg,
    })
}
