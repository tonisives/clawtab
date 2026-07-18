use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::sync::Arc;

use clawtab_lib::config::jobs::{JobStatus, JobsConfig};
use clawtab_lib::config::settings::AppSettings;
use clawtab_lib::events::IpcBroadcastEventSink;
use clawtab_lib::history::HistoryStore;
use clawtab_lib::ipc::{self, IpcCommand, IpcRelayStatus, IpcResponse};
use clawtab_lib::notifications::IpcNotifier;
use clawtab_lib::secrets::SecretsManager;
use clawtab_lib::telegram;

struct DaemonInstanceGuard {
    _file: File,
}

fn acquire_daemon_instance_guard() -> Result<Option<DaemonInstanceGuard>, String> {
    std::fs::create_dir_all("/tmp/clawtab")
        .map_err(|e| format!("failed to create daemon runtime directory: {}", e))?;

    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open("/tmp/clawtab/daemon.lock")
        .map_err(|e| format!("failed to open daemon lock: {}", e))?;

    let lock_result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if lock_result == 0 {
        file.set_len(0)
            .map_err(|e| format!("failed to clear daemon lock: {}", e))?;
        writeln!(file, "{}", std::process::id())
            .map_err(|e| format!("failed to write daemon lock pid: {}", e))?;
        return Ok(Some(DaemonInstanceGuard { _file: file }));
    }

    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::EWOULDBLOCK) || err.raw_os_error() == Some(libc::EAGAIN) {
        Ok(None)
    } else {
        Err(format!("failed to lock daemon instance: {}", err))
    }
}

fn main() {
    // Unset TMUX so child tmux commands connect to the default server,
    // not a nested server this process may have been launched from.
    std::env::remove_var("TMUX");

    // Install rustls crypto provider before any TLS connections (relay, reqwest, etc.)
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls crypto provider");

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    let _instance_guard = match acquire_daemon_instance_guard() {
        Ok(Some(guard)) => guard,
        Ok(None) => {
            log::warn!("another clawtab-daemon instance is already running; exiting");
            return;
        }
        Err(e) => {
            log::error!("{}", e);
            std::process::exit(1);
        }
    };

    log::info!("clawtab-daemon starting");

    let settings = Arc::new(Mutex::new(AppSettings::load()));
    let jobs_config = Arc::new(Mutex::new(JobsConfig::load()));
    let secrets = Arc::new(Mutex::new(SecretsManager::new()));
    let history = Arc::new(Mutex::new(
        HistoryStore::new().expect("failed to initialize history database"),
    ));

    // Run startup migrations
    {
        let mut j = jobs_config.lock();
        clawtab_lib::config::jobs::migrate_job_md_to_central(&mut j.jobs);
        clawtab_lib::config::jobs::migrate_cwt_to_central(&j.jobs);
    }

    let job_status: Arc<Mutex<HashMap<String, JobStatus>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let restored =
            clawtab_lib::scheduler::executor::binary_runtime::reattach_running_binary_jobs(
                &jobs_config.lock(),
            );
        if !restored.is_empty() {
            log::info!(
                "Reattached {} running binary job(s) from runtime state",
                restored.len()
            );
            job_status.lock().extend(restored);
        }
    }
    let active_agents: Arc<Mutex<HashMap<i64, telegram::ActiveAgent>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let relay_handle: Arc<Mutex<Option<clawtab_lib::relay::RelayHandle>>> =
        Arc::new(Mutex::new(None));
    let relay_sub_required: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let relay_auth_expired: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let active_questions: Arc<Mutex<Vec<clawtab_protocol::ClaudeQuestion>>> =
        Arc::new(Mutex::new(Vec::new()));
    let agent_activity: Arc<Mutex<Vec<clawtab_lib::ipc::AgentActivity>>> =
        Arc::new(Mutex::new(Vec::new()));
    let auto_yes_panes: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let protected_panes: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let notification_state: Arc<Mutex<clawtab_lib::notifications::NotificationState>> = Arc::new(
        Mutex::new(clawtab_lib::notifications::NotificationState::new()),
    );
    let pty_manager: clawtab_lib::pty::SharedPtyManager =
        Arc::new(Mutex::new(clawtab_lib::pty::PtyManager::new()));
    let active_agents_notify = Arc::new(tokio::sync::Notify::new());

    let event_subscribers = ipc::new_event_subscribers();
    let event_sink: Arc<dyn clawtab_lib::events::EventSink> =
        Arc::new(IpcBroadcastEventSink::new(event_subscribers.clone()));
    let notifier: Arc<dyn clawtab_lib::notifications::Notifier> =
        Arc::new(IpcNotifier::new(event_subscribers.clone()));
    let hook_runtime = clawtab_lib::agent_hooks::HookRuntime::default();

    let ctx = clawtab_lib::job_context::JobContext {
        secrets: Arc::clone(&secrets),
        history: Arc::clone(&history),
        settings: Arc::clone(&settings),
        job_status: Arc::clone(&job_status),
        active_agents: Arc::clone(&active_agents),
        active_agents_notify: Arc::clone(&active_agents_notify),
        relay: Arc::clone(&relay_handle),
        auto_yes_panes: Arc::clone(&auto_yes_panes),
        protected_panes: Arc::clone(&protected_panes),
        notifier: Some(Arc::clone(&notifier)),
    };

    let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    rt.block_on(async {
        {
            let hook_runtime = hook_runtime.clone();
            let agent_activity = Arc::clone(&agent_activity);
            let event_sink = Arc::clone(&event_sink);
            tokio::spawn(async move {
                clawtab_lib::agent_hooks::run_event_watcher(
                    hook_runtime,
                    agent_activity,
                    event_sink,
                )
                .await;
            });
        }

        // IPC event push server
        {
            let subs = event_subscribers.clone();
            tokio::spawn(async move {
                if let Err(e) = ipc::start_event_server(subs).await {
                    log::error!("IPC event server error: {}", e);
                }
            });
        }

        // IPC server
        {
            let jobs_config = Arc::clone(&jobs_config);
            let relay_sub = Arc::clone(&relay_sub_required);
            let relay_auth = Arc::clone(&relay_auth_expired);
            let active_questions = Arc::clone(&active_questions);
            let agent_activity = Arc::clone(&agent_activity);
            let pty_manager = Arc::clone(&pty_manager);
            let event_sink_for_ipc = Arc::clone(&event_sink);
            let ctx_for_ipc = ctx.clone();
            tokio::spawn(async move {
                let handler = move |cmd: IpcCommand| {
                    let jobs_config = Arc::clone(&jobs_config);
                    let relay_sub = Arc::clone(&relay_sub);
                    let relay_auth = Arc::clone(&relay_auth);
                    let active_questions = Arc::clone(&active_questions);
                    let agent_activity = Arc::clone(&agent_activity);
                    let pty_manager = Arc::clone(&pty_manager);
                    let event_sink_for_ipc = Arc::clone(&event_sink_for_ipc);
                    let ctx_for_ipc = ctx_for_ipc.clone();
                    async move {
                        handle_ipc_command(
                            &jobs_config,
                            &relay_sub,
                            &relay_auth,
                            &active_questions,
                            &agent_activity,
                            &pty_manager,
                            &event_sink_for_ipc,
                            &ctx_for_ipc,
                            cmd,
                        )
                        .await
                    }
                };
                if let Err(e) = ipc::start_ipc_server(handler).await {
                    log::error!("IPC server error: {}", e);
                }
            });
        }

        // Question detection + auto-yes
        {
            let jobs_config = Arc::clone(&jobs_config);
            let job_status = Arc::clone(&job_status);
            let relay = Arc::clone(&relay_handle);
            let active_questions = Arc::clone(&active_questions);
            let agent_activity = Arc::clone(&agent_activity);
            let auto_yes_panes = Arc::clone(&auto_yes_panes);
            let notifier = Arc::clone(&notifier);
            let notification_state = Arc::clone(&notification_state);
            let settings = Arc::clone(&settings);
            let event_sink = Arc::clone(&event_sink);
            let hook_runtime = hook_runtime.clone();
            tokio::spawn(async move {
                clawtab_lib::questions::question_detection_loop(
                    settings,
                    jobs_config,
                    job_status,
                    relay,
                    active_questions,
                    agent_activity,
                    auto_yes_panes,
                    notifier,
                    notification_state,
                    event_sink,
                    hook_runtime,
                )
                .await;
            });
        }

        // Scheduler
        let _scheduler_handle = tokio::spawn(clawtab_lib::scheduler::start(
            Arc::clone(&event_sink),
            Arc::clone(&jobs_config),
            ctx.clone(),
        ));

        // Reattach jobs still running in tmux from previous session
        {
            let event_sink = Arc::clone(&event_sink);
            let jobs_config = Arc::clone(&jobs_config);
            let ctx = ctx.clone();
            tokio::spawn(async move {
                clawtab_lib::scheduler::reattach::reattach_running_jobs(
                    event_sink.as_ref(),
                    &jobs_config,
                    &ctx,
                );
                // Use the protected-panes set persisted by the previous app session.
                // Without this, restarting the daemon while the app is closed (or
                // before the app boots) would sweep the user's plain shell panes.
                clawtab_lib::scheduler::reattach::cleanup_orphaned_shell_windows(
                    &clawtab_lib::config::protected_panes::load_set(),
                );
            });
        }

        // Relay connection (if configured)
        {
            let relay_settings = settings.lock().relay.clone();
            if let Some(rs) = relay_settings {
                let device_token = if rs.device_token.is_empty() {
                    secrets
                        .lock()
                        .get("relay_device_token")
                        .cloned()
                        .unwrap_or_default()
                } else {
                    rs.device_token.clone()
                };

                if rs.enabled && !rs.server_url.is_empty() && !device_token.is_empty() {
                    let ws_url = if rs.server_url.starts_with("http") {
                        rs.server_url.replacen("http", "ws", 1) + "/ws"
                    } else {
                        rs.server_url.clone()
                    };
                    let server_url = rs.server_url.clone();
                    let relay_sub = Arc::clone(&relay_sub_required);
                    let jobs_config = Arc::clone(&jobs_config);
                    let ctx = ctx.clone();
                    let pty_manager = Arc::clone(&pty_manager);
                    let event_sink = Arc::clone(&event_sink);
                    tokio::spawn(async move {
                        clawtab_lib::relay::connect_loop(clawtab_lib::relay::ConnectLoopParams {
                            ws_url,
                            device_token,
                            server_url,
                            relay_sub_required: relay_sub,
                            jobs_config,
                            ctx,
                            pty_manager,
                            event_sink,
                        })
                        .await;
                    });
                }
            }
        }

        // Publish daemon-owned process snapshots for remote clients. Remote
        // clients should read this state rather than triggering tmux scans.
        {
            let jobs_config = Arc::clone(&jobs_config);
            let job_status = Arc::clone(&job_status);
            let pty_manager = Arc::clone(&pty_manager);
            let relay = Arc::clone(&relay_handle);
            tokio::spawn(async move {
                let mut last_snapshot_json = String::new();
                loop {
                    if relay.lock().is_none() {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        continue;
                    }
                    let processes = clawtab_lib::process_snapshot::detect_processes_snapshot(
                        &jobs_config,
                        &job_status,
                        &pty_manager,
                    )
                    .await;
                    let snapshot_json = serde_json::to_string(&processes).unwrap_or_default();
                    if snapshot_json != last_snapshot_json {
                        last_snapshot_json = snapshot_json;
                        let guard = relay.lock();
                        if let Some(handle) = guard.as_ref() {
                            handle.send_message(
                                &clawtab_protocol::DesktopMessage::DetectedProcesses {
                                    id: "daemon_process_snapshot".to_string(),
                                    processes,
                                },
                            );
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            });
        }

        // Telegram agent polling
        {
            let telegram_state = telegram::polling::AgentState {
                settings: Arc::clone(&settings),
                jobs_config: Arc::clone(&jobs_config),
                job_status: Arc::clone(&job_status),
                active_agents: Arc::clone(&active_agents),
                ctx: ctx.clone(),
            };
            tokio::spawn(async move {
                log::info!("Telegram polling task spawned");
                telegram::polling::start_polling(telegram_state).await;
                log::error!("Telegram polling loop exited unexpectedly");
            });
        }

        // Config file watcher
        {
            let jobs_config = Arc::clone(&jobs_config);
            let event_sink = Arc::clone(&event_sink);
            tokio::spawn(async move {
                clawtab_lib::watcher::watch_jobs_dir(jobs_config, event_sink).await;
            });
        }

        log::info!("clawtab-daemon running, waiting for signals");

        // Wait for SIGTERM/SIGINT
        tokio::signal::ctrl_c()
            .await
            .expect("failed to listen for ctrl+c");
        log::info!("clawtab-daemon shutting down");
    });
}

async fn handle_ipc_command(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    relay_sub_required: &Arc<Mutex<bool>>,
    relay_auth_expired: &Arc<Mutex<bool>>,
    active_questions: &Arc<Mutex<Vec<clawtab_protocol::ClaudeQuestion>>>,
    agent_activity: &Arc<Mutex<Vec<clawtab_lib::ipc::AgentActivity>>>,
    pty_manager: &clawtab_lib::pty::SharedPtyManager,
    event_sink: &Arc<dyn clawtab_lib::events::EventSink>,
    ctx: &clawtab_lib::job_context::JobContext,
    cmd: IpcCommand,
) -> IpcResponse {
    let secrets = &ctx.secrets;
    let settings = &ctx.settings;
    let job_status = &ctx.job_status;
    let relay = &ctx.relay;
    let auto_yes_panes = &ctx.auto_yes_panes;
    let protected_panes = &ctx.protected_panes;
    match cmd {
        IpcCommand::Ping => IpcResponse::Pong,
        IpcCommand::ListJobs => {
            let jobs = jobs_config.lock();
            let mut summaries: Vec<clawtab_lib::ipc::JobSummary> = jobs
                .jobs
                .iter()
                .map(|job| clawtab_lib::ipc::JobSummary {
                    group: clawtab_lib::config::jobs::job_group(job).to_string(),
                    name: job.name.clone(),
                    slug: job.slug.clone(),
                })
                .collect();
            summaries.sort_by(|a, b| {
                a.group
                    .cmp(&b.group)
                    .then_with(|| a.name.cmp(&b.name))
                    .then_with(|| a.slug.cmp(&b.slug))
            });
            IpcResponse::Jobs(summaries)
        }
        IpcCommand::RunJob { name } => {
            let jobs = jobs_config.lock();
            let job = clawtab_lib::config::jobs::find_job(&jobs.jobs, &name);
            match job {
                Ok(job) => {
                    let job = job.clone();
                    let ctx = ctx.clone();
                    tokio::spawn(async move {
                        clawtab_lib::scheduler::executor::execute_job(
                            &job,
                            &ctx,
                            "cli",
                            &HashMap::new(),
                            clawtab_lib::scheduler::executor::ExecuteOpts::default(),
                        )
                        .await;
                    });
                    IpcResponse::Ok
                }
                Err(error) => IpcResponse::Error(error),
            }
        }
        IpcCommand::GetAgentIntegration { provider } => {
            match clawtab_lib::agent_hooks::integration_statuses()
                .into_iter()
                .find(|status| status.provider == provider)
            {
                Some(status) => IpcResponse::AgentIntegration(status),
                None => IpcResponse::Error("This provider does not support hooks".to_string()),
            }
        }
        IpcCommand::InstallAgentIntegration { provider } => {
            let helper = std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(|parent| parent.join("clawtab-hook")))
                .filter(|path| path.is_file());
            match clawtab_lib::agent_hooks::install_provider(provider, helper.as_deref()) {
                Ok(()) => match clawtab_lib::agent_hooks::integration_statuses()
                    .into_iter()
                    .find(|status| status.provider == provider)
                {
                    Some(status) => IpcResponse::AgentIntegration(status),
                    None => IpcResponse::Error(
                        "Hook installation completed but status was unavailable".to_string(),
                    ),
                },
                Err(error) => IpcResponse::Error(error),
            }
        }
        IpcCommand::RunJobCli { name } => {
            let job = {
                let jobs = jobs_config.lock();
                clawtab_lib::config::jobs::find_job(&jobs.jobs, &name).cloned()
            };
            let job = match job {
                Ok(job) => job,
                Err(error) => return IpcResponse::Error(error),
            };
            let run_id = uuid::Uuid::new_v4().to_string();
            let slug = job.slug.clone();
            let is_binary = matches!(job.job_type, clawtab_lib::config::jobs::JobType::Binary);
            let ctx = ctx.clone();
            let task_run_id = run_id.clone();
            tokio::spawn(async move {
                clawtab_lib::scheduler::executor::execute_job(
                    &job,
                    &ctx,
                    "cli",
                    &HashMap::new(),
                    clawtab_lib::scheduler::executor::ExecuteOpts {
                        run_id: Some(task_run_id),
                        ..Default::default()
                    },
                )
                .await;
            });
            IpcResponse::RunStarted {
                slug,
                run_id,
                is_binary,
            }
        }
        IpcCommand::PauseJob { name } => {
            let job_slug = {
                let jobs = jobs_config.lock();
                match clawtab_lib::config::jobs::find_job(&jobs.jobs, &name) {
                    Ok(job) => job.slug.clone(),
                    Err(error) => return IpcResponse::Error(error),
                }
            };
            let mut status = job_status.lock();
            match status.get(&job_slug) {
                Some(JobStatus::Running { .. }) => {
                    status.insert(job_slug, JobStatus::Paused);
                    IpcResponse::Ok
                }
                _ => IpcResponse::Error("Job is not running".to_string()),
            }
        }
        IpcCommand::ResumeJob { name } => {
            let job_slug = {
                let jobs = jobs_config.lock();
                match clawtab_lib::config::jobs::find_job(&jobs.jobs, &name) {
                    Ok(job) => job.slug.clone(),
                    Err(error) => return IpcResponse::Error(error),
                }
            };
            let mut status = job_status.lock();
            match status.get(&job_slug) {
                Some(JobStatus::Paused) => {
                    status.insert(job_slug, JobStatus::Idle);
                    IpcResponse::Ok
                }
                _ => IpcResponse::Error("Job is not paused".to_string()),
            }
        }
        IpcCommand::RestartJob { name } => {
            let jobs = jobs_config.lock();
            let job = clawtab_lib::config::jobs::find_job(&jobs.jobs, &name);
            match job {
                Ok(job) => {
                    let job = job.clone();
                    let ctx = ctx.clone();
                    tokio::spawn(async move {
                        clawtab_lib::scheduler::executor::execute_job(
                            &job,
                            &ctx,
                            "restart",
                            &HashMap::new(),
                            clawtab_lib::scheduler::executor::ExecuteOpts::default(),
                        )
                        .await;
                    });
                    IpcResponse::Ok
                }
                Err(error) => IpcResponse::Error(error),
            }
        }
        IpcCommand::GetStatus => {
            let status = job_status.lock().clone();
            IpcResponse::Status(status)
        }
        IpcCommand::OpenSettings => IpcResponse::Error("requires desktop app".to_string()),
        IpcCommand::GetAutoYesPanes => {
            let panes: Vec<String> = auto_yes_panes.lock().iter().cloned().collect();
            IpcResponse::AutoYesPanes(panes)
        }
        IpcCommand::SetAutoYesPanes { pane_ids } => {
            let pane_set: HashSet<String> = pane_ids.iter().cloned().collect();
            *auto_yes_panes.lock() = pane_set;

            {
                let guard = relay.lock();
                if let Some(handle) = guard.as_ref() {
                    handle
                        .send_message(&clawtab_protocol::DesktopMessage::AutoYesPanes { pane_ids });
                }
            }

            event_sink.emit_auto_yes_changed();
            IpcResponse::Ok
        }
        IpcCommand::ToggleAutoYes { pane_id } => {
            let mut panes = auto_yes_panes.lock();
            if panes.contains(&pane_id) {
                panes.remove(&pane_id);
            } else {
                panes.insert(pane_id.clone());
            }
            let pane_ids: Vec<String> = panes.iter().cloned().collect();
            drop(panes);

            {
                let guard = relay.lock();
                if let Some(handle) = guard.as_ref() {
                    handle
                        .send_message(&clawtab_protocol::DesktopMessage::AutoYesPanes { pane_ids });
                }
            }

            event_sink.emit_auto_yes_changed();
            IpcResponse::Ok
        }
        IpcCommand::GetActiveQuestions => {
            let qs = active_questions.lock().clone();
            IpcResponse::ActiveQuestions(qs)
        }
        IpcCommand::GetProviderUsage { provider } => {
            let explicit_tokens = {
                let stored_secrets = secrets.lock();
                clawtab_lib::usage::ZAI_TOKEN_KEYS
                    .iter()
                    .map(|key| stored_secrets.get(key).cloned())
                    .collect()
            };
            let zai_token = clawtab_lib::usage::resolve_zai_token_from_sources(explicit_tokens);
            match clawtab_lib::usage::fetch_provider_usage(&provider, zai_token).await {
                Ok(snapshot) => IpcResponse::ProviderUsage(snapshot),
                Err(error) => IpcResponse::Error(error),
            }
        }
        IpcCommand::GetAgentActivity => {
            let asking_panes: HashSet<String> = active_questions
                .lock()
                .iter()
                .map(|question| question.pane_id.clone())
                .collect();
            let mut activity = agent_activity.lock().clone();
            for item in &mut activity {
                item.asking = asking_panes.contains(&item.pane_id);
                if item.asking {
                    item.working = false;
                }
            }
            IpcResponse::AgentActivity(activity)
        }
        IpcCommand::ListSecretKeys => {
            let s = secrets.lock();
            IpcResponse::SecretKeys(s.list_keys())
        }
        IpcCommand::GetSecretValues { keys } => {
            let s = secrets.lock();
            let pairs: Vec<(String, String)> = keys
                .iter()
                .filter_map(|k| s.get(k).map(|v| (k.clone(), v.clone())))
                .collect();
            IpcResponse::SecretValues(pairs)
        }
        IpcCommand::SetSecret { key, value } => match secrets.lock().set(&key, &value) {
            Ok(()) => IpcResponse::Ok,
            Err(e) => IpcResponse::Error(e),
        },
        IpcCommand::DeleteSecret { key } => match secrets.lock().delete(&key) {
            Ok(()) => IpcResponse::Ok,
            Err(e) => IpcResponse::Error(e),
        },
        IpcCommand::ReloadSecrets => {
            secrets.lock().reload();
            IpcResponse::Ok
        }
        IpcCommand::GetPaneInfo { pane_id } => {
            let pane_pid = std::process::Command::new("tmux")
                .args(["list-panes", "-t", &pane_id, "-F", "#{pane_id} #{pane_pid}"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                        stdout
                            .lines()
                            .find(|l| l.starts_with(&format!("{} ", pane_id)))
                            .and_then(|l| l.split_whitespace().nth(1))
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();

            if pane_pid.is_empty() {
                IpcResponse::PaneInfo {
                    first_query: None,
                    last_query: None,
                    session_started_at: None,
                }
            } else {
                let info = clawtab_lib::agent_session::resolve_session_info(&pane_pid);
                IpcResponse::PaneInfo {
                    first_query: info.first_query,
                    last_query: info.last_query,
                    session_started_at: info.session_started_at,
                }
            }
        }
        IpcCommand::GetRelayStatus => IpcResponse::RelayStatus(compute_relay_status(
            settings,
            secrets,
            relay,
            relay_sub_required,
            relay_auth_expired,
        )),
        IpcCommand::RelayConnect => {
            match spawn_relay_connect(
                relay_sub_required,
                jobs_config,
                ctx,
                pty_manager,
                event_sink,
            ) {
                Ok(()) => IpcResponse::Ok,
                Err(e) => IpcResponse::Error(e),
            }
        }
        IpcCommand::RelayDisconnect => {
            {
                let guard = relay.lock();
                if let Some(handle) = guard.as_ref() {
                    handle.disconnect();
                }
            }
            IpcResponse::Ok
        }
        IpcCommand::ReloadSettings => {
            *settings.lock() = AppSettings::load();
            IpcResponse::Ok
        }
        IpcCommand::StopJob { name } => {
            let mut status = job_status.lock();
            match status.get(&name).cloned() {
                Some(JobStatus::Running {
                    pane_id: Some(pane_id),
                    ..
                }) => {
                    if let Err(e) = clawtab_lib::tmux::kill_pane(&pane_id) {
                        log::warn!("Failed to kill pane {} for {}: {}", pane_id, name, e);
                    }
                    status.insert(name.clone(), JobStatus::Idle);
                    drop(status);
                    event_sink.emit_job_status_changed(name, JobStatus::Idle);
                    IpcResponse::Ok
                }
                Some(JobStatus::Running { .. }) => {
                    drop(status);
                    match clawtab_lib::scheduler::executor::binary_runtime::stop(&name) {
                        Ok(true) => {
                            job_status.lock().insert(name.clone(), JobStatus::Idle);
                            event_sink.emit_job_status_changed(name, JobStatus::Idle);
                            IpcResponse::Ok
                        }
                        Ok(false) => IpcResponse::Error(
                            "Job is running but has no tracked process".to_string(),
                        ),
                        Err(e) => IpcResponse::Error(e),
                    }
                }
                Some(JobStatus::Paused) => {
                    status.insert(name.clone(), JobStatus::Idle);
                    drop(status);
                    event_sink.emit_job_status_changed(name, JobStatus::Idle);
                    IpcResponse::Ok
                }
                _ => IpcResponse::Error("Job is not running".to_string()),
            }
        }
        IpcCommand::ToggleJob { name } => {
            let mut config = jobs_config.lock();
            if let Some(job) = config.jobs.iter_mut().find(|j| j.slug == name) {
                job.enabled = !job.enabled;
                let job = job.clone();
                match config.save_job(&job) {
                    Ok(()) => {
                        *config = JobsConfig::load();
                        drop(config);
                        event_sink.emit_jobs_changed();
                        IpcResponse::Ok
                    }
                    Err(e) => IpcResponse::Error(e),
                }
            } else {
                IpcResponse::Error(format!("Job not found: {}", name))
            }
        }
        IpcCommand::DeleteJob { name } => {
            let mut config = jobs_config.lock();
            let slug = match config
                .jobs
                .iter()
                .find(|j| j.slug == name)
                .map(|j| j.slug.clone())
            {
                Some(s) => s,
                None => return IpcResponse::Error(format!("Job not found: {}", name)),
            };
            if let Err(e) = config.delete_job(&slug) {
                return IpcResponse::Error(e);
            }
            *config = JobsConfig::load();
            drop(config);
            clawtab_lib::relay::push_full_state_if_connected(relay, jobs_config, job_status);
            event_sink.emit_jobs_changed();
            IpcResponse::Ok
        }
        IpcCommand::AnswerQuestion { pane_id, answer } => {
            // Remove question from active list, send answer via tmux send-keys
            let mut qs = active_questions.lock();
            qs.retain(|q| q.pane_id != pane_id);
            drop(qs);
            let _ = std::process::Command::new("tmux")
                .args(["send-keys", "-t", &pane_id, &answer, "Enter"])
                .output();
            event_sink.emit_questions_changed();
            IpcResponse::Ok
        }
        IpcCommand::SetProtectedPanes { pane_ids } => {
            let set: HashSet<String> = pane_ids.into_iter().collect();
            *protected_panes.lock() = set.clone();
            let mut sorted: Vec<String> = set.into_iter().collect();
            sorted.sort();
            if let Err(e) = clawtab_lib::config::protected_panes::save(&sorted) {
                log::warn!("persist protected_panes failed: {}", e);
            }
            IpcResponse::Ok
        }
        IpcCommand::DismissQuestion { pane_id } => {
            let mut qs = active_questions.lock();
            qs.retain(|q| q.pane_id != pane_id);
            drop(qs);
            event_sink.emit_questions_changed();
            IpcResponse::Ok
        }
        IpcCommand::RunJobNow { name, params } => {
            let job_result = {
                let cfg = jobs_config.lock();
                clawtab_lib::config::jobs::find_job(&cfg.jobs, &name).cloned()
            };
            let job = match job_result {
                Ok(j) => j,
                Err(error) => return IpcResponse::Error(error),
            };

            let ctx = ctx.clone();

            if matches!(
                job.job_type,
                clawtab_lib::config::jobs::JobType::Claude
                    | clawtab_lib::config::jobs::JobType::Job
            ) {
                let (pane_tx, pane_rx) = tokio::sync::oneshot::channel();
                tokio::spawn(async move {
                    clawtab_lib::scheduler::executor::execute_job(
                        &job,
                        &ctx,
                        "manual",
                        &params,
                        clawtab_lib::scheduler::executor::ExecuteOpts {
                            use_auto_yes: true,
                            pane_tx: Some(pane_tx),
                            ..Default::default()
                        },
                    )
                    .await;
                });

                match tokio::time::timeout(std::time::Duration::from_secs(10), pane_rx).await {
                    Ok(Ok((pane_id, tmux_session))) => IpcResponse::PaneCreated {
                        pane_id: Some(pane_id),
                        tmux_session: Some(tmux_session),
                    },
                    _ => IpcResponse::PaneCreated {
                        pane_id: None,
                        tmux_session: None,
                    },
                }
            } else {
                tokio::spawn(async move {
                    clawtab_lib::scheduler::executor::execute_job(
                        &job,
                        &ctx,
                        "manual",
                        &params,
                        clawtab_lib::scheduler::executor::ExecuteOpts {
                            use_auto_yes: true,
                            pane_tx: None,
                            ..Default::default()
                        },
                    )
                    .await;
                });
                IpcResponse::PaneCreated {
                    pane_id: None,
                    tmux_session: None,
                }
            }
        }
        IpcCommand::SigintJob { name } => {
            let pane = {
                let st = job_status.lock();
                match st.get(&name).cloned() {
                    Some(JobStatus::Running {
                        pane_id: Some(pane_id),
                        ..
                    }) => Some(pane_id),
                    _ => None,
                }
            };
            let Some(pane_id) = pane else {
                return IpcResponse::Error("Job is not running or has no pane".to_string());
            };
            if let Err(e) = clawtab_lib::tmux::send_sigint_to_pane(&pane_id) {
                return IpcResponse::Error(e);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            match clawtab_lib::tmux::send_sigint_to_pane(&pane_id) {
                Ok(()) => IpcResponse::Ok,
                Err(e) => IpcResponse::Error(e),
            }
        }
        IpcCommand::RunAgent {
            prompt,
            work_dir,
            provider,
            model,
        } => {
            let (settings_snapshot, jobs_snapshot) = {
                let s = settings.lock().clone();
                let j = jobs_config.lock().jobs.clone();
                (s, j)
            };
            let job = match clawtab_lib::agent::build_agent_job(
                &prompt,
                None,
                &settings_snapshot,
                &jobs_snapshot,
                work_dir.as_deref(),
                provider,
                model,
            ) {
                Ok(j) => j,
                Err(e) => return IpcResponse::Error(e),
            };

            let ctx = ctx.clone();

            let (pane_tx, pane_rx) = tokio::sync::oneshot::channel();

            tokio::spawn(async move {
                clawtab_lib::scheduler::executor::execute_job(
                    &job,
                    &ctx,
                    "manual",
                    &HashMap::new(),
                    clawtab_lib::scheduler::executor::ExecuteOpts {
                        use_auto_yes: false,
                        pane_tx: Some(pane_tx),
                        ..Default::default()
                    },
                )
                .await;
            });

            match tokio::time::timeout(std::time::Duration::from_secs(10), pane_rx).await {
                Ok(Ok((pane_id, tmux_session))) => IpcResponse::PaneCreated {
                    pane_id: Some(pane_id),
                    tmux_session: Some(tmux_session),
                },
                _ => IpcResponse::PaneCreated {
                    pane_id: None,
                    tmux_session: None,
                },
            }
        }
        IpcCommand::ListAllPanes => match clawtab_lib::tmux::list_panes_all_with_commands() {
            Ok(raw) => {
                let entries = raw
                    .lines()
                    .filter_map(|line| {
                        let mut parts = line.split('\x1e');
                        Some(clawtab_lib::ipc::PaneEntry {
                            session: parts.next()?.to_string(),
                            window_id: parts.next()?.to_string(),
                            window_name: parts.next()?.to_string(),
                            pane_id: parts.next()?.to_string(),
                            current_command: parts.next().unwrap_or("").to_string(),
                        })
                    })
                    .collect();
                IpcResponse::AllPanes(entries)
            }
            Err(e) => IpcResponse::Error(e),
        },
        IpcCommand::OpenJobFolder { name } => {
            let dir = {
                let jobs = jobs_config.lock();
                clawtab_lib::config::jobs::find_job(&jobs.jobs, &name)
                    .ok()
                    .and_then(|j| {
                        j.folder_path.clone().or_else(|| {
                            std::path::Path::new(&j.path)
                                .parent()
                                .map(|p| p.to_string_lossy().into_owned())
                        })
                    })
            };
            match dir {
                Some(d) => {
                    let editor = std::env::var("EDITOR").unwrap_or_else(|_| "open".to_string());
                    match std::process::Command::new(&editor).arg(&d).spawn() {
                        Ok(_) => IpcResponse::Ok,
                        Err(e) => IpcResponse::Error(format!("Failed to spawn {}: {}", editor, e)),
                    }
                }
                None => IpcResponse::Error(format!("Job '{}' has no folder", name)),
            }
        }
    }
}

fn compute_relay_status(
    settings: &Arc<Mutex<AppSettings>>,
    secrets: &Arc<Mutex<SecretsManager>>,
    relay: &Arc<Mutex<Option<clawtab_lib::relay::RelayHandle>>>,
    relay_sub_required: &Arc<Mutex<bool>>,
    relay_auth_expired: &Arc<Mutex<bool>>,
) -> IpcRelayStatus {
    let relay_settings = settings.lock().relay.clone().unwrap_or_default();
    let connected = relay.lock().is_some();
    let subscription_required = *relay_sub_required.lock();
    let auth_expired = *relay_auth_expired.lock();

    let device_token_stored = !relay_settings.device_token.is_empty() || {
        let s = secrets.lock();
        s.get("relay_device_token")
            .map(|t| !t.is_empty())
            .unwrap_or(false)
    };
    let configured = !relay_settings.server_url.is_empty() && device_token_stored;

    IpcRelayStatus {
        enabled: relay_settings.enabled,
        connected,
        subscription_required,
        auth_expired,
        configured,
        server_url: relay_settings.server_url,
        device_name: relay_settings.device_name,
    }
}

fn spawn_relay_connect(
    relay_sub_required: &Arc<Mutex<bool>>,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &clawtab_lib::job_context::JobContext,
    pty_manager: &clawtab_lib::pty::SharedPtyManager,
    event_sink: &Arc<dyn clawtab_lib::events::EventSink>,
) -> Result<(), String> {
    let settings_guard = ctx.settings.lock();
    let rs = settings_guard
        .relay
        .as_ref()
        .ok_or_else(|| "No relay settings configured".to_string())?;
    if rs.server_url.is_empty() {
        return Err("Relay server URL not configured".to_string());
    }
    let server_url = rs.server_url.clone();
    let yaml_token = rs.device_token.clone();
    let ws_url = if rs.server_url.starts_with("http") {
        rs.server_url.replacen("http", "ws", 1) + "/ws"
    } else {
        rs.server_url.clone()
    };
    drop(settings_guard);

    let device_token = if yaml_token.is_empty() {
        ctx.secrets
            .lock()
            .get("relay_device_token")
            .cloned()
            .unwrap_or_default()
    } else {
        yaml_token
    };
    if device_token.is_empty() {
        return Err("Device token not configured".to_string());
    }

    *relay_sub_required.lock() = false;

    let relay_sub = Arc::clone(relay_sub_required);
    let jobs_config = Arc::clone(jobs_config);
    let ctx = ctx.clone();
    let pty_manager = Arc::clone(pty_manager);
    let event_sink = Arc::clone(event_sink);

    tokio::spawn(async move {
        clawtab_lib::relay::connect_loop(clawtab_lib::relay::ConnectLoopParams {
            ws_url,
            device_token,
            server_url,
            relay_sub_required: relay_sub,
            jobs_config,
            ctx,
            pty_manager,
            event_sink,
        })
        .await;
    });

    Ok(())
}
