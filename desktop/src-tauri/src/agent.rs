//! Shared agent utilities used by commands, relay, and telegram modules.

use crate::agent_session::ProcessProvider;
use crate::config::jobs::{Job, JobType, NotifyTarget, TelegramLogMode, TelegramNotify};
use crate::config::settings::AppSettings;

/// Returns the path to the agent working directory.
pub fn agent_dir_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config")
        .join("clawtab")
        .join("agent")
}

/// Return the stable group name for an ad-hoc agent slug.
///
/// Ad-hoc agents use unique slugs such as `agent-clawtab-1782946653914` so
/// their tmux panes do not collide. Their on-disk state should be grouped by
/// the part before that uniqueness suffix.
pub(crate) fn agent_group_from_slug(slug: &str) -> String {
    let base = slug.strip_prefix("agent-").unwrap_or(slug);
    let group = base
        .rsplit_once('-')
        .filter(|(_, suffix)| {
            suffix.len() >= 10 && suffix.bytes().all(|byte| byte.is_ascii_digit())
        })
        .map(|(prefix, _)| prefix)
        .filter(|prefix| !prefix.is_empty())
        .unwrap_or(base);

    sanitize_agent_group(group)
}

fn sanitize_agent_group(group: &str) -> String {
    let mut result = String::with_capacity(group.len().min(64));
    for byte in group.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' {
            result.push(byte.to_ascii_lowercase() as char);
        } else if !result.ends_with('-') {
            result.push('-');
        }
        if result.len() >= 64 {
            break;
        }
    }
    let result = result.trim_matches('-');
    if result.is_empty() || result.bytes().all(|byte| byte.is_ascii_digit()) {
        "default".to_string()
    } else {
        result.to_string()
    }
}

pub(crate) fn agent_group_dir(group: &str) -> std::path::PathBuf {
    agent_dir_path().join(sanitize_agent_group(group))
}

pub(crate) fn agent_logs_dir(group: &str) -> std::path::PathBuf {
    agent_group_dir(group).join("logs")
}

/// Migrate ad-hoc logs written by older builds under `jobs/agent-*` or the
/// ungrouped `agent/logs` directory. Configured jobs always have `job.yaml`;
/// only agent-only directories are eligible for this migration.
pub(crate) fn migrate_legacy_agent_storage() {
    let Some(config_dir) = crate::config::config_dir() else {
        return;
    };
    let jobs_dir = config_dir.join("jobs");
    if let Ok(entries) = std::fs::read_dir(&jobs_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !path.is_dir() || !name.starts_with("agent-") || path.join("job.yaml").exists() {
                continue;
            }
            let group = agent_group_from_slug(name);
            let legacy_logs = path.join("logs");
            migrate_log_dir(&legacy_logs, &agent_logs_dir(&group));
            remove_empty_legacy_dir(&legacy_logs);
            remove_empty_legacy_dir(&path);
        }
    }

    let ungrouped_logs = agent_dir_path().join("logs");
    migrate_log_dir(&ungrouped_logs, &agent_logs_dir("default"));
    remove_empty_legacy_dir(&ungrouped_logs);
}

fn migrate_log_dir(source: &std::path::Path, destination: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(source) else {
        return;
    };
    if std::fs::create_dir_all(destination).is_err() {
        return;
    }
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        if name == ".DS_Store" {
            continue;
        }
        let target = destination.join(name);
        if target.exists() {
            continue;
        }
        if let Err(e) = std::fs::rename(&path, &target) {
            log::warn!(
                "Failed to migrate agent log {} to {}: {}",
                path.display(),
                target.display(),
                e
            );
        }
    }
}

fn remove_empty_legacy_dir(path: &std::path::Path) {
    if !path.is_dir() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if entry.file_name() == ".DS_Store" {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let _ = std::fs::remove_dir(path);
    if path.file_name().and_then(|name| name.to_str()) == Some("logs") {
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }
}

/// Remove the one-shot prompt belonging to a finished ad-hoc agent.
/// Only generated prompt files inside the central agent directory are eligible.
pub(crate) fn remove_agent_prompt(path: &std::path::Path) {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    if !name.starts_with(".agent-prompt-") {
        return;
    }
    let agent_dir = agent_dir_path();
    let Ok(relative) = path.strip_prefix(&agent_dir) else {
        return;
    };
    if relative.components().count() > 2 {
        return;
    }
    match std::fs::remove_file(path) {
        Ok(()) => log::info!("Removed finished agent prompt {}", path.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("Failed to remove agent prompt {}: {}", path.display(), e),
    }
}

/// Generate the auto-generated context for the agent directory.
/// Contains workspace info, available tools, and Telegram communication instructions.
pub(crate) fn generate_agent_cwt_context(
    settings: &AppSettings,
    jobs: &[Job],
    chat_id: Option<i64>,
) -> String {
    let mut out = String::new();
    write_header(&mut out);
    write_communication_protocol(&mut out, settings, chat_id);
    write_rules(&mut out);
    write_allowed_directories(&mut out, settings, jobs);
    write_configured_jobs(&mut out, jobs);
    write_cli_help(&mut out);
    out
}

fn write_header(out: &mut String) {
    out.push_str("<!-- Auto-generated by ClawTab. Regenerated on agent start. -->\n");
    out.push_str("# ClawTab Telegram Agent\n\n");
    out.push_str("You are the ClawTab interactive agent. The user communicates with you through Telegram.\n\n");
}

fn write_communication_protocol(out: &mut String, settings: &AppSettings, chat_id: Option<i64>) {
    out.push_str("## Communication Protocol\n\n");
    out.push_str("IMPORTANT: You MUST send ALL your responses and questions to the user via Telegram using curl.\n");
    out.push_str("The user cannot see your terminal output. Telegram is your ONLY communication channel.\n\n");

    let has_token = settings
        .telegram
        .as_ref()
        .is_some_and(|tg| !tg.bot_token.is_empty());
    let cid = chat_id.or_else(|| {
        settings
            .telegram
            .as_ref()
            .and_then(|tg| tg.chat_ids.first().copied())
    });
    if !has_token {
        return;
    }
    let Some(cid) = cid else { return };

    out.push_str("### Sending messages\n\n");
    out.push_str("Send every response, question, status update, or result to Telegram:\n\n");
    out.push_str("```bash\n");
    out.push_str(&format!(
        "curl -s -X POST \"https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{{\"chat_id\": {}, \"text\": \"Your message here\"}}'\n",
        cid
    ));
    out.push_str("```\n\n");

    out.push_str("### Receiving messages\n\n");
    out.push_str("The user's follow-up messages are typed into your terminal input automatically by ClawTab.\n");
    out.push_str("After sending a question or completing a task, simply wait - the user's reply will appear as your next prompt input.\n\n");
}

fn write_rules(out: &mut String) {
    out.push_str("### Rules\n\n");
    out.push_str("- ALWAYS send your answers and questions via the Telegram curl command above.\n");
    out.push_str("- After completing a task or asking a question, wait for the next input.\n");
    out.push_str("- Do NOT terminate or exit unless the user explicitly asks you to.\n");
    out.push_str(
        "- Keep messages concise. For long output, summarize and offer to share details.\n",
    );
    out.push_str("- Only operate within the allowed directories listed below.\n");
}

fn write_allowed_directories(out: &mut String, settings: &AppSettings, jobs: &[Job]) {
    let mut dirs: Vec<String> = Vec::new();
    for job in jobs {
        if let Some(ref fp) = job.folder_path {
            if !dirs.contains(fp) {
                dirs.push(fp.clone());
            }
        }
        if let Some(ref wd) = job.work_dir {
            if !dirs.contains(wd) {
                dirs.push(wd.clone());
            }
        }
    }
    if !settings.default_work_dir.is_empty() && !dirs.contains(&settings.default_work_dir) {
        dirs.push(settings.default_work_dir.clone());
    }

    out.push_str("\n## Allowed Directories\n\n");
    for d in &dirs {
        out.push_str(&format!("- `{}`\n", d));
    }
    if let Some(config_dir) = crate::config::config_dir() {
        out.push_str(&format!("- `{}` (ClawTab config)\n", config_dir.display()));
    }
}

fn write_configured_jobs(out: &mut String, jobs: &[Job]) {
    if jobs.is_empty() {
        return;
    }
    out.push_str("\n## Configured Jobs\n\n");
    for job in jobs {
        let jt = match job.job_type {
            JobType::Binary => "bin",
            JobType::Claude => "claude",
            JobType::Job => "job",
        };
        let dir = job
            .folder_path
            .as_deref()
            .or(job.work_dir.as_deref())
            .unwrap_or("-");
        out.push_str(&format!("- `{}` [{}] dir: `{}`\n", job.name, jt, dir));
    }
}

fn write_cli_help(out: &mut String) {
    out.push_str("\n## Job Management CLI\n\n");
    out.push_str("`cwtctl` is available for managing ClawTab jobs:\n\n");
    out.push_str("```\n");
    out.push_str("cwtctl jobs list      # List configured jobs grouped by group\n");
    out.push_str("cwtctl jobs status    # Show status of all jobs\n");
    out.push_str("cwtctl jobs run <group>/<name> # Run a job and attach/follow output\n");
    out.push_str("cwtctl jobs pause <group>/<name> # Pause a running job\n");
    out.push_str("cwtctl jobs resume <group>/<name> # Resume a paused job\n");
    out.push_str("cwtctl jobs restart <group>/<name> # Restart a job\n");
    out.push_str("cwtctl agent auto-yes [toggle|check] [pane_id] # Manage auto-yes\n");
    out.push_str("cwtctl agent info [pane_id] # Show agent session info\n");
    out.push_str("cwtctl pane open [pane_id] # Open a tmux pane in ClawTab\n");
    out.push_str("cwtctl daemon ping    # Check if ClawTab daemon is running\n");
    out.push_str("```\n");
}

/// Build a synthetic `Job` for running Claude as an ad-hoc interactive agent.
/// Writes enriched prompt to `~/.config/clawtab/agent/<group>/...`
/// and returns a Job that can be passed to `execute_job`.
///
/// When `target_dir` is provided, the agent runs in that directory instead of the
/// default agent dir. The job name/slug become `agent-<folder>` so multiple
/// per-folder agents can coexist.
pub fn build_agent_job(
    prompt: &str,
    chat_id: Option<i64>,
    settings: &AppSettings,
    jobs: &[Job],
    target_dir: Option<&str>,
    provider: Option<ProcessProvider>,
    model: Option<String>,
) -> Result<Job, String> {
    let agent_dir = agent_dir_path();
    std::fs::create_dir_all(&agent_dir)
        .map_err(|e| format!("Failed to create agent dir: {}", e))?;

    // Derive name/slug and work_dir from target_dir. Slug must be unique per
    // spawn: executor.rs prunes panes by slug (list_panes_by_slug), so reusing
    // an existing pane's slug would kill it when a new agent/shell is spawned
    // in the same folder.
    let unique_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let (job_id, job_slug, work_dir, agent_group) = if let Some(dir) = target_dir {
        let project_dir = std::path::Path::new(dir);
        let folder = project_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("agent");
        let name = format!("agent-{}", folder);
        let slug = format!("agent-{}-{}", folder, unique_suffix);
        (
            name,
            slug,
            project_dir.to_string_lossy().to_string(),
            sanitize_agent_group(folder),
        )
    } else {
        (
            "agent".to_string(),
            format!("agent-{}", unique_suffix),
            agent_dir.display().to_string(),
            "default".to_string(),
        )
    };

    let group_dir = agent_group_dir(&agent_group);
    std::fs::create_dir_all(&group_dir)
        .map_err(|e| format!("Failed to create agent group dir: {}", e))?;

    // For group/folder agents, skip the shared context - just run claude in
    // that folder. The default agent keeps its generated context in its group.
    let enriched = if target_dir.is_some() {
        prompt.to_string()
    } else {
        let context = generate_agent_cwt_context(settings, jobs, chat_id);
        let cwt_md_path = group_dir.join("cwt.md");
        std::fs::write(&cwt_md_path, &context)
            .map_err(|e| format!("Failed to write agent cwt.md: {}", e))?;
        format!("@{}\n\n{}", cwt_md_path.display(), prompt)
    };

    // Write prompt to a per-agent file to avoid collisions
    let prompt_filename = format!(".agent-prompt-{}.md", job_slug);
    let prompt_path = group_dir.join(&prompt_filename);
    std::fs::write(&prompt_path, &enriched)
        .map_err(|e| format!("Failed to write agent prompt: {}", e))?;

    Ok(Job {
        name: job_id,
        job_type: JobType::Claude,
        enabled: true,
        path: prompt_path.display().to_string(),
        args: Vec::new(),
        cron: String::new(),
        secret_keys: Vec::new(),
        env: std::collections::HashMap::new(),
        work_dir: Some(work_dir),
        tmux_session: None,
        aerospace_workspace: None,
        folder_path: None,
        job_id: Some("default".to_string()),
        telegram_chat_id: chat_id,
        telegram_log_mode: TelegramLogMode::OnPrompt,
        telegram_notify: TelegramNotify::default(),
        notify_target: if chat_id.is_some() {
            NotifyTarget::Telegram
        } else {
            NotifyTarget::None
        },
        group: "agent".to_string(),
        slug: job_slug,
        skill_paths: Vec::new(),
        params: Vec::new(),
        kill_on_end: false,
        auto_yes: false,
        agent_provider: provider,
        agent_model: model,
        added_at: Some(chrono::Utc::now().to_rfc3339()),
        max_history: 3,
    })
}
