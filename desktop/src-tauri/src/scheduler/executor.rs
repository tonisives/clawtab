use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chrono::Utc;
use tokio::process::Command;

use crate::config::jobs::{Job, JobStatus, JobType, NotifyTarget};
use crate::config::settings::AppSettings;
use crate::history::RunRecord;
use crate::job_context::JobContext;
use crate::secrets::SecretsManager;
use crate::telegram::ActiveAgent;

use super::monitor::{MonitorParams, TelegramStream};

/// Result from a tmux job: the tmux session and pane ID for monitoring.
struct TmuxHandle {
    tmux_session: String,
    pane_id: String,
}

/// Per-call options for `execute_job`. Use `ExecuteOpts::default()` for a
/// basic fire-and-forget run.
#[derive(Default)]
pub struct ExecuteOpts {
    /// Enable auto-yes tracking for this run's tmux pane.
    pub use_auto_yes: bool,
    /// Channel to notify the caller of the spawned pane/session ids.
    pub pane_tx: Option<tokio::sync::oneshot::Sender<(String, String)>>,
    /// External trigger id. When set, used as run_id and threaded into
    /// the spawned process via CLAWTAB_RESULT_FILE so the job can write a
    /// structured result. On finish the monitor reads that file and pushes
    /// a TriggerResult to the relay.
    pub trigger_id: Option<String>,
}

fn resolve_agent_model(
    job: &Job,
    settings: &AppSettings,
    provider: crate::agent_session::ProcessProvider,
) -> Option<String> {
    if let Some(model) = job.agent_model.clone() {
        return Some(model);
    }
    if job.agent_provider.is_none() || provider == settings.default_provider {
        return settings.default_model.clone();
    }
    None
}

pub async fn execute_job(
    job: &Job,
    ctx: &JobContext,
    trigger: &str,
    params: &HashMap<String, String>,
    opts: ExecuteOpts,
) {
    // Fill any missing param entries from each JobParam's declared default value
    // so cron-triggered runs (which pass an empty map) still get sensible values.
    let merged_params: Option<HashMap<String, String>> = if job
        .params
        .iter()
        .any(|p| p.value.is_some() && !params.contains_key(&p.name))
    {
        let mut m = params.clone();
        apply_param_defaults(job, &mut m);
        Some(m)
    } else {
        None
    };
    let params: &HashMap<String, String> = merged_params.as_ref().unwrap_or(params);

    let secrets = &ctx.secrets;
    let history = &ctx.history;
    let settings = &ctx.settings;
    let job_status = &ctx.job_status;
    let active_agents = &ctx.active_agents;
    let active_agents_notify = &ctx.active_agents_notify;
    let relay = &ctx.relay;
    let auto_yes_panes = if opts.use_auto_yes {
        Some(&ctx.auto_yes_panes)
    } else {
        None
    };
    let protected_panes = Some(&ctx.protected_panes);
    let notifier = ctx.notifier.clone();
    let mut pane_tx = opts.pane_tx;
    let trigger_id = opts.trigger_id;

    let run_id = trigger_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let started_at = Utc::now().to_rfc3339();

    // Pre-compute the result file path so we can both inject it into the
    // child process env and read it back on finish. trigger_id-only feature.
    let result_file: Option<std::path::PathBuf> = trigger_id.as_ref().and_then(|_| {
        crate::config::config_dir().map(|d| {
            d.join("jobs")
                .join(&job.slug)
                .join("logs")
                .join(format!("{}.json", run_id))
        })
    });
    if let Some(ref p) = result_file {
        if let Some(parent) = p.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::warn!("Failed to pre-create result dir {}: {}", parent.display(), e);
            }
        }
    }

    // Mark as running (pane_id filled in later for tmux jobs)
    {
        let new_status = JobStatus::Running {
            run_id: run_id.clone(),
            started_at: started_at.clone(),
            pane_id: None,
            tmux_session: None,
        };
        let mut status = job_status.lock().unwrap();
        status.insert(job.slug.clone(), new_status.clone());
        drop(status);
        crate::relay::push_status_update(relay, &job.slug, &new_status);
    }

    // Pre-compute the streaming log path for binary jobs so it's persisted
    // on the row from the start. tmux jobs ignore this (their output lives
    // in tmux's scrollback / capture).
    let stream_log_path: Option<std::path::PathBuf> = if matches!(job.job_type, JobType::Binary) {
        crate::config::jobs::JobsConfig::jobs_dir_public().map(|d| {
            d.join(&job.slug)
                .join("logs")
                .join(format!("{}.log", run_id))
        })
    } else {
        None
    };
    if let Some(ref p) = stream_log_path {
        if let Some(parent) = p.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::warn!("Failed to pre-create log dir {}: {}", parent.display(), e);
            }
        }
    }

    let record = RunRecord {
        id: run_id.clone(),
        job_id: job.slug.clone(),
        started_at: started_at.clone(),
        finished_at: None,
        exit_code: None,
        trigger: trigger.to_string(),
        stdout: String::new(),
        stderr: String::new(),
        pane_id: None,
        log_path: stream_log_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
    };

    {
        let h = history.lock().unwrap();
        if let Err(e) = h.insert(&record) {
            log::error!("Failed to insert run record: {}", e);
        }
        match h.prune_job_to_limit(&job.slug, job.max_history) {
            Ok(pruned_panes) => {
                for pane_id in pruned_panes {
                    if let Err(e) = crate::tmux::kill_pane(&pane_id) {
                        log::warn!("Failed to kill pruned pane {}: {}", pane_id, e);
                    }
                }
            }
            Err(e) => log::error!("Failed to prune job history for {}: {}", job.slug, e),
        }
    }

    // Also kill orphan tmux panes for this slug whose history rows were already
    // pruned in earlier runs but the panes remained alive (kill_on_end=false).
    // The new pane is about to spawn, so keep `max_history - 1` existing panes.
    // Order by history.started_at (authoritative); panes without a history row
    // are treated as oldest and killed first.
    if job.max_history > 0 {
        let keep = job.max_history.saturating_sub(1) as usize;
        let started_map = {
            let h = history.lock().unwrap();
            h.pane_started_at_for_job(&job.slug).unwrap_or_default()
        };
        match crate::tmux::list_panes_by_slug(&job.slug) {
            Ok(panes) => {
                let mut with_ts: Vec<(String, String)> = panes
                    .into_iter()
                    .map(|(pid, _)| {
                        let ts = started_map.get(&pid).cloned().unwrap_or_default();
                        (pid, ts)
                    })
                    .collect();
                with_ts.sort_by(|a, b| b.1.cmp(&a.1));
                for (pane_id, _) in with_ts.into_iter().skip(keep) {
                    if let Err(e) = crate::tmux::kill_pane(&pane_id) {
                        log::warn!("Failed to kill orphan pane {}: {}", pane_id, e);
                    }
                }
            }
            Err(e) => log::warn!("Failed to list panes for slug {}: {}", job.slug, e),
        }
    }

    log::info!("[{}] Starting job '{}' ({})", run_id, job.name, trigger);

    let result: Result<(Option<i32>, String, String, Option<TmuxHandle>), String> =
        match job.job_type {
            JobType::Binary => execute_binary_job(
                job,
                secrets,
                settings,
                params,
                result_file.as_deref(),
                stream_log_path.as_deref(),
            )
            .await
            .map(|(code, out, err)| (code, out, err, None)),
            JobType::Claude => {
                execute_claude_job(job, secrets, settings, params, result_file.as_deref()).await
            }
            JobType::Job => {
                execute_folder_job(job, secrets, settings, params, result_file.as_deref()).await
            }
        };

    // Get telegram config for notifications
    let telegram_config = {
        let s = settings.lock().unwrap();
        s.telegram.clone()
    };

    match result {
        Ok((exit_code, stdout, stderr, tmux_handle)) => {
            // If we got a tmux handle, update status with pane info and spawn the monitor
            if let Some(handle) = tmux_handle {
                {
                    let new_status = JobStatus::Running {
                        run_id: run_id.clone(),
                        started_at: started_at.clone(),
                        pane_id: Some(handle.pane_id.clone()),
                        tmux_session: Some(handle.tmux_session.clone()),
                    };
                    let mut status = job_status.lock().unwrap();
                    status.insert(job.slug.clone(), new_status.clone());
                    drop(status);
                    crate::relay::push_status_update(relay, &job.slug, &new_status);
                }
                // Notify caller of the pane_id if requested
                if let Some(tx) = pane_tx.take() {
                    let _ = tx.send((handle.pane_id.clone(), handle.tmux_session.clone()));
                }
                // Persist pane_id to history so reattach can find it after restart
                {
                    let h = history.lock().unwrap();
                    let _ = h.update_pane_id(&run_id, &handle.pane_id);
                }
                // If job has auto_yes enabled, add this pane to auto_yes_panes
                if job.auto_yes {
                    if let Some(ay_panes) = auto_yes_panes {
                        let mut panes = ay_panes.lock().unwrap();
                        panes.insert(handle.pane_id.clone());
                        log::info!(
                            "Auto-yes enabled for job '{}' pane '{}'",
                            job.name,
                            handle.pane_id
                        );
                    }
                }
                // Register in active_agents so Telegram replies can be relayed
                // (only needed when using Telegram notifications)
                if job.notify_target == NotifyTarget::Telegram {
                    let chat_id = job.telegram_chat_id.or_else(|| {
                        telegram_config
                            .as_ref()
                            .and_then(|c| c.chat_ids.first().copied())
                    });
                    if let Some(chat_id) = chat_id {
                        if let Ok(mut map) = active_agents.lock() {
                            log::info!(
                                "Registering active agent for chat_id={} pane={}",
                                chat_id,
                                handle.pane_id,
                            );
                            map.insert(
                                chat_id,
                                ActiveAgent {
                                    pane_id: handle.pane_id.clone(),
                                    tmux_session: handle.tmux_session.clone(),
                                    run_id: run_id.clone(),
                                    job_id: job.name.clone(),
                                },
                            );
                        }
                        active_agents_notify.notify_waiters();
                    }
                }

                // Only build TelegramStream when notify_target is Telegram
                let telegram = if job.notify_target == NotifyTarget::Telegram {
                    build_telegram_stream(&telegram_config, job.telegram_chat_id)
                } else {
                    None
                };
                let notify_on_success = telegram_config
                    .as_ref()
                    .map(|c| c.notify_on_success)
                    .unwrap_or(true);

                let params = MonitorParams {
                    tmux_session: handle.tmux_session,
                    pane_id: handle.pane_id,
                    run_id: run_id.clone(),
                    job_id: job.name.clone(),
                    slug: job.slug.clone(),
                    kill_on_end: job.kill_on_end,
                    telegram,
                    telegram_notify: job.telegram_notify.clone(),
                    notify_target: job.notify_target.clone(),
                    history: Arc::clone(history),
                    job_status: Arc::clone(job_status),
                    notify_on_success,
                    relay: Arc::clone(relay),
                    notifier: notifier.clone(),
                    is_reattach: false,
                    protected_panes: protected_panes
                        .map(Arc::clone)
                        .unwrap_or_else(|| Arc::new(Mutex::new(HashSet::new()))),
                    trigger_id: trigger_id.clone(),
                    result_file: result_file.clone(),
                };
                tokio::spawn(super::monitor::monitor_pane(params));
                return;
            }

            // Non-tmux (binary) job: finalize immediately
            let finished_at = Utc::now().to_rfc3339();

            log::info!(
                "[{}] Job '{}' finished with exit code {:?}",
                run_id,
                job.name,
                exit_code
            );

            let success = matches!(exit_code, Some(0) | None);

            {
                let new_status = if success {
                    JobStatus::Success {
                        last_run: finished_at.clone(),
                    }
                } else {
                    JobStatus::Failed {
                        last_run: finished_at.clone(),
                        exit_code: exit_code.unwrap_or(-1),
                    }
                };
                let mut status = job_status.lock().unwrap();
                status.insert(job.slug.clone(), new_status.clone());
                drop(status);
                crate::relay::push_status_update(relay, &job.slug, &new_status);
            }

            {
                let h = history.lock().unwrap();
                if let Err(e) =
                    h.update_finished(&run_id, &finished_at, exit_code, &stdout, &stderr)
                {
                    log::error!("Failed to update run record: {}", e);
                }
            }

            match job.notify_target {
                NotifyTarget::Telegram => {
                    if let Some(ref tg) = telegram_config {
                        send_job_notification(
                            tg,
                            job.telegram_chat_id,
                            &job.name,
                            exit_code,
                            success,
                            &stdout,
                            &stderr,
                        )
                        .await;
                    }
                }
                NotifyTarget::App => {
                    let event = if success { "completed" } else { "failed" };
                    crate::relay::push_job_notification(relay, &job.slug, event, &run_id);
                    if let Some(ref n) = notifier {
                        n.notify_job(&job.name, event);
                    }
                }
                NotifyTarget::None => {}
            }

            if let Some(ref tid) = trigger_id {
                let parsed = result_file
                    .as_ref()
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
                let status_str = if success { "succeeded" } else { "failed" };
                crate::relay::push_trigger_result(
                    relay,
                    tid,
                    status_str,
                    exit_code,
                    parsed,
                    None,
                );
            }
        }
        Err(e) => {
            let finished_at = Utc::now().to_rfc3339();
            log::error!("[{}] Job '{}' failed: {}", run_id, job.name, e);

            {
                let new_status = JobStatus::Failed {
                    last_run: finished_at.clone(),
                    exit_code: -1,
                };
                let mut status = job_status.lock().unwrap();
                status.insert(job.slug.clone(), new_status.clone());
                drop(status);
                crate::relay::push_status_update(relay, &job.slug, &new_status);
            }

            {
                let h = history.lock().unwrap();
                if let Err(e2) =
                    h.update_finished(&run_id, &finished_at, Some(-1), "", &e.to_string())
                {
                    log::error!("Failed to update run record: {}", e2);
                }
            }

            match job.notify_target {
                NotifyTarget::Telegram => {
                    if let Some(ref tg) = telegram_config {
                        send_job_notification(
                            tg,
                            job.telegram_chat_id,
                            &job.name,
                            Some(-1),
                            false,
                            "",
                            &e,
                        )
                        .await;
                    }
                }
                NotifyTarget::App => {
                    crate::relay::push_job_notification(relay, &job.slug, "failed", &run_id);
                    if let Some(ref n) = notifier {
                        n.notify_job(&job.name, "failed");
                    }
                }
                NotifyTarget::None => {}
            }

            if let Some(ref tid) = trigger_id {
                crate::relay::push_trigger_result(
                    relay,
                    tid,
                    "failed",
                    Some(-1),
                    None,
                    Some(e.clone()),
                );
            }
        }
    }
}

/// Build a TelegramStream for the monitor, using per-job chat_id or global chat_ids.
fn build_telegram_stream(
    config: &Option<crate::telegram::TelegramConfig>,
    job_chat_id: Option<i64>,
) -> Option<TelegramStream> {
    let config = config.as_ref()?;
    if !config.is_configured() {
        return None;
    }
    let chat_id = job_chat_id.or_else(|| config.chat_ids.first().copied())?;
    Some(TelegramStream {
        bot_token: config.bot_token.clone(),
        chat_id,
    })
}

async fn execute_binary_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
    params: &HashMap<String, String>,
    result_file: Option<&std::path::Path>,
    stream_log_path: Option<&std::path::Path>,
) -> Result<(Option<i32>, String, String), String> {
    let work_dir = job.work_dir.clone().unwrap_or_else(|| {
        let s = settings.lock().unwrap();
        s.default_work_dir.clone()
    });

    let mut cmd = Command::new(&job.path);
    cmd.args(&job.args);
    cmd.env_clear();

    // Set PATH and HOME from current process
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }

    // Inject secrets
    {
        let sm = secrets.lock().unwrap();
        for key in &job.secret_keys {
            if let Some(value) = sm.get(key) {
                cmd.env(key, value);
            }
        }
    }

    // Static env vars
    for (k, v) in &job.env {
        cmd.env(k, v);
    }

    if let Some(p) = result_file {
        cmd.env("CLAWTAB_RESULT_FILE", p);
    }

    // Trigger params -> CLAWTAB_PARAM_<UPPER_KEY>. Lets binary jobs accept
    // per-invocation inputs from /v1/triggers/run without needing a Claude
    // agent for templating.
    for (k, v) in params {
        let key = format!("CLAWTAB_PARAM_{}", k.to_ascii_uppercase());
        cmd.env(key, v);
    }

    cmd.current_dir(&work_dir);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;

    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    // Open the streaming log file. Writers from both reader tasks share an
    // Arc<Mutex<File>> so interleaving stays line-coherent; line-based reads
    // mean a single lock per line and no torn writes between stdout/stderr.
    let log_file: Option<Arc<Mutex<std::fs::File>>> = stream_log_path.and_then(|p| {
        match std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(p)
        {
            Ok(f) => Some(Arc::new(Mutex::new(f))),
            Err(e) => {
                log::warn!("Failed to open stream log {}: {}", p.display(), e);
                None
            }
        }
    });

    use tokio::io::AsyncBufReadExt;
    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));

    let stdout_task = {
        let buf = Arc::clone(&stdout_buf);
        let file = log_file.clone();
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stdout_pipe).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                {
                    let mut b = buf.lock().unwrap();
                    b.push_str(&line);
                    b.push('\n');
                }
                if let Some(ref f) = file {
                    use std::io::Write;
                    let mut g = f.lock().unwrap();
                    let _ = g.write_all(line.as_bytes());
                    let _ = g.write_all(b"\n");
                    let _ = g.flush();
                }
            }
        })
    };

    let stderr_task = {
        let buf = Arc::clone(&stderr_buf);
        let file = log_file.clone();
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr_pipe).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                {
                    let mut b = buf.lock().unwrap();
                    b.push_str(&line);
                    b.push('\n');
                }
                if let Some(ref f) = file {
                    use std::io::Write;
                    let mut g = f.lock().unwrap();
                    let _ = g.write_all(line.as_bytes());
                    let _ = g.write_all(b"\n");
                    let _ = g.flush();
                }
            }
        })
    };

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for process: {}", e))?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let stdout = Arc::try_unwrap(stdout_buf)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();
    let stderr = Arc::try_unwrap(stderr_buf)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();
    let exit_code = status.code();

    Ok((exit_code, stdout, stderr))
}

async fn execute_claude_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
    params: &HashMap<String, String>,
    result_file: Option<&std::path::Path>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
    use crate::tmux;

    let (provider, model, tmux_session, work_dir, agent_command) = {
        let s = settings.lock().unwrap();
        let provider = job.agent_provider.unwrap_or(s.default_provider);
        let model = resolve_agent_model(job, &s, provider);
        let session = job
            .tmux_session
            .clone()
            .unwrap_or_else(|| s.default_tmux_session.clone());
        let wd = job
            .work_dir
            .clone()
            .unwrap_or_else(|| s.default_work_dir.clone());
        let command = match provider {
            crate::agent_session::ProcessProvider::Claude => s.claude_path.clone(),
            crate::agent_session::ProcessProvider::Codex
            | crate::agent_session::ProcessProvider::Opencode => provider.binary_name().to_string(),
            crate::agent_session::ProcessProvider::Shell => String::new(),
        };
        (provider, model, session, wd, command)
    };

    let mut env_vars = collect_env_vars(job, secrets, settings);
    if let Some(p) = result_file {
        env_vars.push((
            "CLAWTAB_RESULT_FILE".to_string(),
            p.to_string_lossy().into_owned(),
        ));
    }

    let window_name = project_window_name(job);
    let prompt_path = &job.path;

    // Read prompt file content so we can pass it inline (preserves @ references)
    let raw_prompt = std::fs::read_to_string(prompt_path)
        .map_err(|e| format!("Failed to read prompt file {}: {}", prompt_path, e))?;

    // Replace {key} placeholders with param values
    let raw_prompt = apply_params(raw_prompt, params);

    // Prepend skill @ references if any
    let prompt_content = if job.skill_paths.is_empty() {
        raw_prompt
    } else {
        let skill_refs = job
            .skill_paths
            .iter()
            .map(|p| format!("@{}", p))
            .collect::<Vec<_>>()
            .join(" ");
        format!("{}\n\n{}", skill_refs, raw_prompt)
    };

    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    // Create session if it doesn't exist
    if !tmux::session_exists(&tmux_session) {
        tmux::create_session(&tmux_session)?;
    }

    // Every spawn gets its own window — clawtab needs independent geometry
    // per tab, which tmux splits can't give us.
    let pane_id = tmux::create_window_with_cwd(&tmux_session, &window_name, Some(&work_dir), &env_vars)?;

    let model_flag = model
        .filter(|_| provider.supports_model_flag())
        .map(|m| provider.model_flag_format(&m))
        .unwrap_or_default();

    let escaped_prompt = prompt_content.replace('\'', "'\\''");
    let send_cmd = match provider {
        crate::agent_session::ProcessProvider::Claude
        | crate::agent_session::ProcessProvider::Codex => {
            format!(
                "cd {} && {}{} $'{}'",
                work_dir, agent_command, model_flag, escaped_prompt
            )
        }
        crate::agent_session::ProcessProvider::Opencode => {
            format!(
                "cd {} && {}{} --prompt $'{}'",
                work_dir, agent_command, model_flag, escaped_prompt
            )
        }
        crate::agent_session::ProcessProvider::Shell => {
            if escaped_prompt.is_empty() {
                format!("cd {}", work_dir)
            } else {
                format!("cd {} && {}", work_dir, escaped_prompt)
            }
        }
    };

    tmux::send_keys_to_pane(&tmux_session, &pane_id, &send_cmd)?;

    // Tag pane with job slug so reattach can identify it. Title is a
    // best-effort hint (the running process can overwrite it via escape
    // sequences); the user option is the authoritative tag.
    if let Err(e) = tmux::set_pane_title(&pane_id, &job.slug) {
        log::warn!("Failed to set pane title for '{}': {}", job.slug, e);
    }
    if let Err(e) = tmux::set_pane_slug(&pane_id, &job.slug) {
        log::warn!("Failed to set pane slug for '{}': {}", job.slug, e);
    }

    // Move to aerospace workspace if configured
    if let Some(ref workspace) = job.aerospace_workspace {
        if crate::aerospace::is_available() {
            // Focus the tmux window first, then move it
            let _ = tmux::focus_window(&tmux_session, &window_name);
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            if let Err(e) = crate::aerospace::move_window_to_workspace(workspace) {
                log::warn!(
                    "Failed to move window to aerospace workspace '{}': {}",
                    workspace,
                    e
                );
            }
        }
    }

    let handle = TmuxHandle {
        tmux_session,
        pane_id,
    };
    Ok((Some(0), String::new(), String::new(), Some(handle)))
}

async fn execute_folder_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
    params: &HashMap<String, String>,
    result_file: Option<&std::path::Path>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
    use crate::cwt::CwtFolder;
    use crate::tmux;

    let folder_path = job
        .folder_path
        .as_ref()
        .ok_or("Folder job requires folder_path")?;

    let job_id = job.job_id.as_deref().unwrap_or("default");
    let project_root = std::path::Path::new(folder_path);

    let _folder = CwtFolder::from_path_with_job(project_root, job_id)?;

    // Read job.md from central location (~/.config/clawtab/jobs/{slug}/job.md)
    let central_job_md = crate::config::jobs::central_job_md_path(&job.slug)
        .ok_or("Could not determine config directory")?;

    if !central_job_md.exists() {
        return Err(format!(
            "No job.md found for '{}' at {}",
            job.slug,
            central_job_md.display()
        ));
    }

    let raw_prompt = std::fs::read_to_string(&central_job_md)
        .map_err(|e| format!("Failed to read {}: {}", central_job_md.display(), e))?;

    // Replace {key} placeholders with param values
    let raw_prompt = apply_params(raw_prompt, params);

    let (provider, model, tmux_session, work_dir, agent_command) = {
        let s = settings.lock().unwrap();
        let provider = job.agent_provider.unwrap_or(s.default_provider);
        let model = resolve_agent_model(job, &s, provider);
        let session = job
            .tmux_session
            .clone()
            .unwrap_or_else(|| s.default_tmux_session.clone());
        let command = match provider {
            crate::agent_session::ProcessProvider::Claude => s.claude_path.clone(),
            crate::agent_session::ProcessProvider::Codex
            | crate::agent_session::ProcessProvider::Opencode => provider.binary_name().to_string(),
            crate::agent_session::ProcessProvider::Shell => String::new(),
        };
        (provider, model, session, folder_path.clone(), command)
    };

    let prompt_content = if provider == crate::agent_session::ProcessProvider::Shell {
        raw_prompt
    } else {
        // Build prompt: shared context, then per-job context, then skills, then per-job instructions.
        let shared_context = crate::config::jobs::central_project_context_path(&job.slug)
            .and_then(|p| std::fs::read_to_string(&p).ok())
            .unwrap_or_default();
        let job_context = crate::config::jobs::central_job_context_path(&job.slug)
            .and_then(|p| std::fs::read_to_string(&p).ok())
            .unwrap_or_default();

        let skill_refs = job
            .skill_paths
            .iter()
            .map(|p| format!("@{}", p))
            .collect::<Vec<_>>()
            .join(" ");
        let skill_part = if skill_refs.is_empty() {
            String::new()
        } else {
            format!(" {}", skill_refs)
        };

        let mut prompt_parts = Vec::new();
        if !shared_context.is_empty() {
            prompt_parts.push(shared_context);
        }
        if !job_context.is_empty() {
            prompt_parts.push(job_context);
        }
        if !skill_part.is_empty() {
            prompt_parts.push(skill_part.trim().to_string());
        }
        prompt_parts.push(raw_prompt);
        prompt_parts.join("\n\n")
    };

    let mut env_vars = collect_env_vars(job, secrets, settings);
    if let Some(p) = result_file {
        env_vars.push((
            "CLAWTAB_RESULT_FILE".to_string(),
            p.to_string_lossy().into_owned(),
        ));
    }
    let window_name = project_window_name(job);

    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    if !tmux::session_exists(&tmux_session) {
        tmux::create_session(&tmux_session)?;
    }

    // Every spawn gets its own window (see execute_claude_job).
    let pane_id = tmux::create_window_with_cwd(&tmux_session, &window_name, Some(&work_dir), &env_vars)?;

    let model_flag = model
        .filter(|_| provider.supports_model_flag())
        .map(|m| provider.model_flag_format(&m))
        .unwrap_or_default();

    let escaped_prompt = prompt_content.replace('\'', "'\\''");
    let send_cmd = match provider {
        crate::agent_session::ProcessProvider::Claude
        | crate::agent_session::ProcessProvider::Codex => {
            format!(
                "cd {} && {}{} $'{}'",
                work_dir, agent_command, model_flag, escaped_prompt
            )
        }
        crate::agent_session::ProcessProvider::Opencode => {
            format!(
                "cd {} && {}{} --prompt $'{}'",
                work_dir, agent_command, model_flag, escaped_prompt
            )
        }
        crate::agent_session::ProcessProvider::Shell => {
            if escaped_prompt.is_empty() {
                format!("cd {}", work_dir)
            } else {
                format!("cd {} && {}", work_dir, escaped_prompt)
            }
        }
    };

    tmux::send_keys_to_pane(&tmux_session, &pane_id, &send_cmd)?;

    // Tag pane with job slug so reattach can identify it. Title is a
    // best-effort hint (the running process can overwrite it); the user
    // option is the authoritative tag.
    if let Err(e) = tmux::set_pane_title(&pane_id, &job.slug) {
        log::warn!("Failed to set pane title for '{}': {}", job.slug, e);
    }
    if let Err(e) = tmux::set_pane_slug(&pane_id, &job.slug) {
        log::warn!("Failed to set pane slug for '{}': {}", job.slug, e);
    }

    // Move to aerospace workspace if configured
    if let Some(ref workspace) = job.aerospace_workspace {
        if crate::aerospace::is_available() {
            let _ = tmux::focus_window(&tmux_session, &window_name);
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            if let Err(e) = crate::aerospace::move_window_to_workspace(workspace) {
                log::warn!(
                    "Failed to move window to aerospace workspace '{}': {}",
                    workspace,
                    e
                );
            }
        }
    }

    let handle = TmuxHandle {
        tmux_session,
        pane_id,
    };
    Ok((Some(0), String::new(), String::new(), Some(handle)))
}

/// Fill missing entries in a runtime params HashMap from each JobParam's default value.
/// Explicit values already in the map take precedence; only params with a `value` default
/// are auto-filled when absent.
pub fn apply_param_defaults(job: &Job, params: &mut HashMap<String, String>) {
    for p in &job.params {
        if let Some(default) = &p.value {
            params.entry(p.name.clone()).or_insert_with(|| default.clone());
        }
    }
}

/// Replace `{key}` placeholders in a prompt string with the provided param values.
fn apply_params(mut prompt: String, params: &HashMap<String, String>) -> String {
    for (key, value) in params {
        prompt = prompt.replace(&format!("{{{}}}", key), value);
    }
    prompt
}

/// Collect env vars from job's secret_keys as (key, value) pairs.
/// Also auto-injects TELEGRAM_BOT_TOKEN from global settings when the job
/// has a telegram_chat_id but doesn't explicitly list the token in secret_keys.
fn collect_env_vars(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
) -> Vec<(String, String)> {
    let sm = secrets.lock().unwrap();
    let mut vars = Vec::new();

    let is_agent = job.name == "agent";

    if is_agent {
        // Agent jobs get ALL secrets injected
        for key in sm.list_keys() {
            if let Some(value) = sm.get(&key) {
                vars.push((key, value.clone()));
            }
        }
    } else {
        for key in &job.secret_keys {
            if let Some(value) = sm.get(key) {
                vars.push((key.clone(), value.clone()));
            }
        }
    }

    // Auto-inject TELEGRAM_BOT_TOKEN from global settings when job uses Telegram
    if !vars.iter().any(|(k, _)| k == "TELEGRAM_BOT_TOKEN") {
        if job.notify_target == NotifyTarget::Telegram || is_agent {
            let s = settings.lock().unwrap();
            if let Some(ref tg) = s.telegram {
                if !tg.bot_token.is_empty() {
                    vars.push(("TELEGRAM_BOT_TOKEN".to_string(), tg.bot_token.clone()));
                }
            }
        }
    }

    vars
}

/// Generate a unique tmux window name for a single agent spawn.
///
/// Each spawn gets its own window so clawtab can resize it independently —
/// splits in a shared window force all panes to the same geometry, which
/// breaks per-tab sizing in the viewer.
fn project_window_name(job: &Job) -> String {
    let project = match job.slug.split_once('/') {
        Some((prefix, _)) if !prefix.is_empty() => prefix,
        _ => &job.name,
    };
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("cwt-{}-{}", project, suffix)
}

/// Send telegram notification, routing to per-job chat_id if set.
async fn send_job_notification(
    config: &crate::telegram::TelegramConfig,
    job_chat_id: Option<i64>,
    job_id: &str,
    exit_code: Option<i32>,
    success: bool,
    stdout: &str,
    stderr: &str,
) {
    if !config.is_configured() {
        return;
    }

    if success && !config.notify_on_success {
        return;
    }
    if !success && !config.notify_on_failure {
        return;
    }

    let status = if success { "completed" } else { "failed" };
    let code_str = exit_code
        .map(|c| format!(" (exit {})", c))
        .unwrap_or_default();

    let mut text = format!(
        "<b>ClawTab</b>: Job <code>{}</code> {}{}",
        job_id, status, code_str
    );

    // Include stdout/stderr output for binary jobs (truncated to stay within Telegram limits)
    let output = if !stdout.trim().is_empty() && !stderr.trim().is_empty() {
        format!("{}\n{}", stdout.trim(), stderr.trim())
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        String::new()
    };

    if !output.is_empty() {
        // Strip ANSI color codes and escape HTML entities in output
        let escaped = crate::telegram::strip_ansi(&output)
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        // Truncate to keep within Telegram's 4096 char limit
        let max_output = 4096 - text.len() - 30; // leave room for <pre> tags and newlines
        let truncated = if escaped.len() > max_output {
            format!("{}...", &escaped[..max_output])
        } else {
            escaped
        };
        text.push_str(&format!("\n<pre>{}</pre>", truncated));
    }

    // Use per-job chat_id if set, otherwise fall back to global chat_ids
    let chat_ids: Vec<i64> = if let Some(cid) = job_chat_id {
        vec![cid]
    } else {
        config.chat_ids.clone()
    };

    for chat_id in chat_ids {
        if let Err(e) = crate::telegram::send_message(&config.bot_token, chat_id, &text).await {
            log::error!("Failed to send Telegram notification to {}: {}", chat_id, e);
        }
    }
}
