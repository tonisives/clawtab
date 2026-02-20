use std::collections::HashMap;

use crate::config::jobs::{Job, JobStatus};

pub enum AgentCommand {
    Help,
    Jobs,
    Status,
    Run(String),
    Pause(String),
    Resume(String),
    Agent(String),
    Unknown(String),
}

pub fn parse_command(text: &str) -> Option<AgentCommand> {
    let text = text.trim();
    if !text.starts_with('/') {
        return None;
    }

    let parts: Vec<&str> = text.splitn(2, ' ').collect();
    let cmd = parts[0];
    let arg = parts.get(1).map(|s| s.trim().to_string());

    Some(match cmd {
        "/help" | "/start" => AgentCommand::Help,
        "/jobs" | "/list" => AgentCommand::Jobs,
        "/status" => AgentCommand::Status,
        "/run" => match arg {
            Some(name) => AgentCommand::Run(name),
            None => AgentCommand::Unknown("/run requires a job name".to_string()),
        },
        "/pause" => match arg {
            Some(name) => AgentCommand::Pause(name),
            None => AgentCommand::Unknown("/pause requires a job name".to_string()),
        },
        "/resume" => match arg {
            Some(name) => AgentCommand::Resume(name),
            None => AgentCommand::Unknown("/resume requires a job name".to_string()),
        },
        "/agent" => match arg {
            Some(prompt) if !prompt.is_empty() => AgentCommand::Agent(prompt),
            _ => AgentCommand::Unknown("/agent requires a prompt".to_string()),
        },
        _ => AgentCommand::Unknown(format!("Unknown command: {}", cmd)),
    })
}

pub fn format_help() -> String {
    [
        "<b>ClawTab Agent</b>",
        "",
        "/jobs - List all configured jobs",
        "/status - Show job statuses",
        "/run &lt;name&gt; - Run a job",
        "/pause &lt;name&gt; - Pause a running job",
        "/resume &lt;name&gt; - Resume a paused job",
        "/agent &lt;prompt&gt; - Run Claude Code with a prompt",
        "/help - Show this help",
    ]
    .join("\n")
}

pub fn format_jobs(jobs: &[Job]) -> String {
    if jobs.is_empty() {
        return "No jobs configured.".to_string();
    }

    let mut lines = vec!["<b>Jobs:</b>".to_string()];
    for job in jobs {
        let enabled = if job.enabled { "on" } else { "off" };
        let jt = match job.job_type {
            crate::config::jobs::JobType::Binary => "bin",
            crate::config::jobs::JobType::Claude => "claude",
            crate::config::jobs::JobType::Folder => "folder",
        };
        lines.push(format!(
            "  <code>{}</code> [{}] ({}) {}",
            job.name, jt, job.cron, enabled
        ));
    }
    lines.join("\n")
}

pub fn format_status(statuses: &HashMap<String, JobStatus>) -> String {
    if statuses.is_empty() {
        return "No job statuses.".to_string();
    }

    let mut names: Vec<&String> = statuses.keys().collect();
    names.sort();

    let mut lines = vec!["<b>Status:</b>".to_string()];
    for name in names {
        let status = &statuses[name];
        let status_str = match status {
            JobStatus::Idle => "idle".to_string(),
            JobStatus::Running { started_at, .. } => format!("running since {}", started_at),
            JobStatus::Success { last_run } => format!("success ({})", last_run),
            JobStatus::Failed {
                last_run,
                exit_code,
            } => format!("failed exit {} ({})", exit_code, last_run),
            JobStatus::Paused => "paused".to_string(),
        };
        lines.push(format!("  <code>{}</code>: {}", name, status_str));
    }
    lines.join("\n")
}
