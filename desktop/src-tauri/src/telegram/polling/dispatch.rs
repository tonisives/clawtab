//! Routes one Telegram `Update` to the right handler and turns the result
//! into an outgoing reply.

use crate::config::jobs::{Job, JobStatus};
use crate::telegram::{
    self,
    commands::{self, AgentCommand},
    types::Update,
    TelegramConfig,
};

use super::{agent, lock_or_log, AgentState};

pub(super) async fn handle_update(update: &Update, config: &TelegramConfig, state: &AgentState) {
    if let Some(ref message) = update.message {
        if !config.chat_ids.contains(&message.chat.id) {
            log::debug!(
                "Ignoring message from unauthorized chat {}",
                message.chat.id
            );
        } else if let Some(ref text) = message.text {
            log::info!(
                "Telegram message from {}: {}",
                message.chat.id,
                &text[..text.len().min(100)]
            );
            if let Some(reply) = handle_message(text, config, state, message.chat.id).await {
                log::info!("Sending reply: {}", &reply[..reply.len().min(100)]);
                if let Err(e) =
                    telegram::send_message(&config.bot_token, message.chat.id, &reply).await
                {
                    log::error!("Failed to send reply: {}", e);
                }
            }
        }
    }

    if let Some(ref cq) = update.callback_query {
        let _ = telegram::answer_callback_query(&config.bot_token, &cq.id).await;
        let Some(ref data) = cq.data else { return };
        let Some(chat_id) = cq.message.as_ref().map(|m| m.chat.id) else {
            return;
        };
        if !config.chat_ids.contains(&chat_id) {
            return;
        }
        log::info!("Callback query from chat {}: {}", chat_id, data);
        if let Some(reply) = handle_message(data, config, state, chat_id).await {
            if let Err(e) = telegram::send_message(&config.bot_token, chat_id, &reply).await {
                log::error!("Failed to send callback reply: {}", e);
            }
        }
    }
}

pub(super) async fn handle_message(
    text: &str,
    config: &TelegramConfig,
    state: &AgentState,
    chat_id: i64,
) -> Option<String> {
    if let Some(cmd) = commands::parse_command(text) {
        log::info!("Parsed Telegram command: {:?}", cmd);
        return Some(match cmd {
            AgentCommand::Help => commands::format_help(),
            AgentCommand::Jobs => {
                let jobs: Vec<Job> = lock_or_log(&state.jobs_config, "jobs_config")
                    .map(|c| c.jobs.clone())
                    .unwrap_or_default();
                commands::format_jobs(&jobs)
            }
            AgentCommand::Status => {
                let statuses = lock_or_log(&state.job_status, "job_status")
                    .map(|s| s.clone())
                    .unwrap_or_default();
                commands::format_status(&statuses)
            }
            AgentCommand::Run(name, params) => handle_run(state, name, params),
            AgentCommand::Pause(name) => match lock_or_log(&state.job_status, "job_status") {
                Some(mut status) => match status.get(&name) {
                    Some(JobStatus::Running { .. }) => {
                        status.insert(name.clone(), JobStatus::Paused);
                        format!("Paused job <code>{}</code>", name)
                    }
                    _ => format!("Job <code>{}</code> is not running", name),
                },
                None => "Internal error".to_string(),
            },
            AgentCommand::Resume(name) => match lock_or_log(&state.job_status, "job_status") {
                Some(mut status) => match status.get(&name) {
                    Some(JobStatus::Paused) => {
                        status.insert(name.clone(), JobStatus::Idle);
                        format!("Resumed job <code>{}</code>", name)
                    }
                    _ => format!("Job <code>{}</code> is not paused", name),
                },
                None => "Internal error".to_string(),
            },
            AgentCommand::Agent(prompt) => {
                agent::handle_agent_command(&prompt, config, state, chat_id).await
            }
            AgentCommand::AgentExit => agent::handle_exit_command(state, chat_id).await,
            AgentCommand::Unknown(msg) => msg,
        });
    }

    agent::relay_to_agent(text, state, chat_id).await
}

fn handle_run(
    state: &AgentState,
    name: String,
    params: std::collections::HashMap<String, String>,
) -> String {
    let job = lock_or_log(&state.jobs_config, "jobs_config")
        .and_then(|c| c.jobs.iter().find(|j| j.name == name).cloned());
    let Some(job) = job else {
        return format!("Job not found: {}", name);
    };

    if let Some(msg) = missing_params_message(&job, &params) {
        return msg;
    }

    spawn_job(job, state.ctx.clone(), params);
    format!("Started job <code>{}</code>", name)
}

/// Returns Some(error_message) if any required (no default) params are
/// missing, None when the job is ready to spawn.
fn missing_params_message(
    job: &Job,
    params: &std::collections::HashMap<String, String>,
) -> Option<String> {
    if job.params.is_empty() {
        return None;
    }
    let missing: Vec<&str> = job
        .params
        .iter()
        .filter(|p| !params.contains_key(p.name.as_str()) && p.value.is_none())
        .map(|p| p.name.as_str())
        .collect();
    if missing.is_empty() {
        return None;
    }
    Some(format!(
        "Missing params: {}. Usage: /run {} {}",
        missing.join(", "),
        job.name,
        job.params
            .iter()
            .map(|p| format!("{}=value", p.name))
            .collect::<Vec<_>>()
            .join(" "),
    ))
}

fn spawn_job(
    job: Job,
    ctx: crate::job_context::JobContext,
    params: std::collections::HashMap<String, String>,
) {
    tokio::spawn(async move {
        crate::scheduler::executor::execute_job(
            &job,
            &ctx,
            "telegram",
            &params,
            crate::scheduler::executor::ExecuteOpts::default(),
        )
        .await;
    });
}
