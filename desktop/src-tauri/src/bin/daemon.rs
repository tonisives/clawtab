use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use clawtab_lib::config::jobs::{JobStatus, JobsConfig};
use clawtab_lib::config::settings::AppSettings;
use clawtab_lib::events::IpcBroadcastEventSink;
use clawtab_lib::history::HistoryStore;
use clawtab_lib::ipc::{self, IpcCommand, IpcRelayStatus, IpcResponse};
use clawtab_lib::notifications::OsascriptNotifier;
use clawtab_lib::secrets::SecretsManager;
use clawtab_lib::telegram;

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

    log::info!("clawtab-daemon starting");

    let settings = Arc::new(Mutex::new(AppSettings::load()));
    let jobs_config = Arc::new(Mutex::new(JobsConfig::load()));
    let secrets = Arc::new(Mutex::new(SecretsManager::new()));
    let history = Arc::new(Mutex::new(
        HistoryStore::new().expect("failed to initialize history database"),
    ));

    // Run startup migrations
    {
        let mut j = jobs_config.lock().unwrap();
        clawtab_lib::config::jobs::migrate_job_md_to_central(&mut j.jobs);
        clawtab_lib::config::jobs::migrate_cwt_to_central(&j.jobs);
    }

    let job_status: Arc<Mutex<HashMap<String, JobStatus>>> = Arc::new(Mutex::new(HashMap::new()));
    let active_agents: Arc<Mutex<HashMap<i64, telegram::ActiveAgent>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let relay_handle: Arc<Mutex<Option<clawtab_lib::relay::RelayHandle>>> =
        Arc::new(Mutex::new(None));
    let relay_sub_required: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let relay_auth_expired: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let active_questions: Arc<Mutex<Vec<clawtab_protocol::ClaudeQuestion>>> =
        Arc::new(Mutex::new(Vec::new()));
    let auto_yes_panes: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let protected_panes: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let notification_state: Arc<Mutex<clawtab_lib::notifications::NotificationState>> = Arc::new(
        Mutex::new(clawtab_lib::notifications::NotificationState::new()),
    );
    let pty_manager: clawtab_lib::pty::SharedPtyManager =
        Arc::new(Mutex::new(clawtab_lib::pty::PtyManager::new()));

    let event_subscribers = ipc::new_event_subscribers();
    let event_sink: Arc<dyn clawtab_lib::events::EventSink> =
        Arc::new(IpcBroadcastEventSink::new(event_subscribers.clone()));
    let notifier: Arc<dyn clawtab_lib::notifications::Notifier> = Arc::new(OsascriptNotifier);

    let ctx = clawtab_lib::job_context::JobContext {
        secrets: Arc::clone(&secrets),
        history: Arc::clone(&history),
        settings: Arc::clone(&settings),
        job_status: Arc::clone(&job_status),
        active_agents: Arc::clone(&active_agents),
        relay: Arc::clone(&relay_handle),
        auto_yes_panes: Arc::clone(&auto_yes_panes),
        protected_panes: Arc::clone(&protected_panes),
        notifier: Some(Arc::clone(&notifier)),
    };

    let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    rt.block_on(async {
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
            let pty_manager = Arc::clone(&pty_manager);
            let event_sink_for_ipc = Arc::clone(&event_sink);
            let ctx_for_ipc = ctx.clone();
            tokio::spawn(async move {
                let handler = move |cmd: IpcCommand| {
                    let jobs_config = Arc::clone(&jobs_config);
                    let relay_sub = Arc::clone(&relay_sub);
                    let relay_auth = Arc::clone(&relay_auth);
                    let active_questions = Arc::clone(&active_questions);
                    let pty_manager = Arc::clone(&pty_manager);
                    let event_sink_for_ipc = Arc::clone(&event_sink_for_ipc);
                    let ctx_for_ipc = ctx_for_ipc.clone();
                    async move {
                        handle_ipc_command(
                            &jobs_config,
                            &relay_sub,
                            &relay_auth,
                            &active_questions,
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
            let auto_yes_panes = Arc::clone(&auto_yes_panes);
            let notifier = Arc::clone(&notifier);
            let notification_state = Arc::clone(&notification_state);
            tokio::spawn(async move {
                clawtab_lib::questions::question_detection_loop(
                    jobs_config,
                    job_status,
                    relay,
                    active_questions,
                    auto_yes_panes,
                    notifier,
                    notification_state,
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
                // Daemon has no ClawTab UI, so nothing is protected.
                clawtab_lib::scheduler::reattach::cleanup_orphaned_shell_windows(&HashSet::new());
            });
        }

        // Relay connection (if configured)
        {
            let relay_settings = settings.lock().unwrap().relay.clone();
            if let Some(rs) = relay_settings {
                let device_token = if rs.device_token.is_empty() {
                    secrets
                        .lock()
                        .unwrap()
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
                        clawtab_lib::relay::connect_loop(
                            clawtab_lib::relay::ConnectLoopParams {
                                ws_url,
                                device_token,
                                server_url,
                                relay_sub_required: relay_sub,
                                jobs_config,
                                ctx,
                                pty_manager,
                                event_sink,
                            },
                        )
                        .await;
                    });
                }
            }
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
            let jobs = jobs_config.lock().unwrap();
            let names: Vec<String> = jobs.jobs.iter().map(|j| j.name.clone()).collect();
            IpcResponse::Jobs(names)
        }
        IpcCommand::RunJob { name } => {
            let jobs = jobs_config.lock().unwrap();
            let job = jobs.jobs.iter().find(|j| j.name == name);
            match job {
                Some(job) => {
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
                None => IpcResponse::Error(format!("Job not found: {}", name)),
            }
        }
        IpcCommand::PauseJob { name } => {
            let mut status = job_status.lock().unwrap();
            match status.get(&name) {
                Some(JobStatus::Running { .. }) => {
                    status.insert(name, JobStatus::Paused);
                    IpcResponse::Ok
                }
                _ => IpcResponse::Error("Job is not running".to_string()),
            }
        }
        IpcCommand::ResumeJob { name } => {
            let mut status = job_status.lock().unwrap();
            match status.get(&name) {
                Some(JobStatus::Paused) => {
                    status.insert(name, JobStatus::Idle);
                    IpcResponse::Ok
                }
                _ => IpcResponse::Error("Job is not paused".to_string()),
            }
        }
        IpcCommand::RestartJob { name } => {
            let jobs = jobs_config.lock().unwrap();
            let job = jobs.jobs.iter().find(|j| j.name == name);
            match job {
                Some(job) => {
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
                None => IpcResponse::Error(format!("Job not found: {}", name)),
            }
        }
        IpcCommand::GetStatus => {
            let status = job_status.lock().unwrap().clone();
            IpcResponse::Status(status)
        }
        IpcCommand::OpenSettings => IpcResponse::Error("requires desktop app".to_string()),
        IpcCommand::OpenPane { .. } => IpcResponse::Error("requires desktop app".to_string()),
        IpcCommand::GetAutoYesPanes => {
            let panes: Vec<String> = auto_yes_panes.lock().unwrap().iter().cloned().collect();
            IpcResponse::AutoYesPanes(panes)
        }
        IpcCommand::SetAutoYesPanes { pane_ids } => {
            let pane_set: HashSet<String> = pane_ids.iter().cloned().collect();
            *auto_yes_panes.lock().unwrap() = pane_set;

            if let Ok(guard) = relay.lock() {
                if let Some(handle) = guard.as_ref() {
                    handle
                        .send_message(&clawtab_protocol::DesktopMessage::AutoYesPanes { pane_ids });
                }
            }

            event_sink.emit_auto_yes_changed();
            IpcResponse::Ok
        }
        IpcCommand::ToggleAutoYes { pane_id } => {
            let mut panes = auto_yes_panes.lock().unwrap();
            if panes.contains(&pane_id) {
                panes.remove(&pane_id);
            } else {
                panes.insert(pane_id.clone());
            }
            let pane_ids: Vec<String> = panes.iter().cloned().collect();
            drop(panes);

            if let Ok(guard) = relay.lock() {
                if let Some(handle) = guard.as_ref() {
                    handle
                        .send_message(&clawtab_protocol::DesktopMessage::AutoYesPanes { pane_ids });
                }
            }

            event_sink.emit_auto_yes_changed();
            IpcResponse::Ok
        }
        IpcCommand::GetActiveQuestions => {
            let qs = active_questions.lock().unwrap().clone();
            IpcResponse::ActiveQuestions(qs)
        }
        IpcCommand::ListSecretKeys => {
            let s = secrets.lock().unwrap();
            IpcResponse::SecretKeys(s.list_keys())
        }
        IpcCommand::GetSecretValues { keys } => {
            let s = secrets.lock().unwrap();
            let pairs: Vec<(String, String)> = keys
                .iter()
                .filter_map(|k| s.get(k).map(|v| (k.clone(), v.clone())))
                .collect();
            IpcResponse::SecretValues(pairs)
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
        IpcCommand::GetRelayStatus => {
            IpcResponse::RelayStatus(compute_relay_status(
                settings,
                secrets,
                relay,
                relay_sub_required,
                relay_auth_expired,
            ))
        }
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
            if let Ok(guard) = relay.lock() {
                if let Some(handle) = guard.as_ref() {
                    handle.disconnect();
                }
            }
            IpcResponse::Ok
        }
        IpcCommand::ReloadSettings => {
            *settings.lock().unwrap() = AppSettings::load();
            IpcResponse::Ok
        }
        IpcCommand::StopJob { name } => {
            let mut status = job_status.lock().unwrap();
            match status.get(&name).cloned() {
                Some(JobStatus::Running { .. }) | Some(JobStatus::Paused) => {
                    status.insert(name.clone(), JobStatus::Idle);
                    drop(status);
                    event_sink.emit_job_status_changed(name, JobStatus::Idle);
                    IpcResponse::Ok
                }
                _ => IpcResponse::Error("Job is not running".to_string()),
            }
        }
        IpcCommand::ToggleJob { name } => {
            let mut config = jobs_config.lock().unwrap();
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
            let mut config = jobs_config.lock().unwrap();
            let slug = match config.jobs.iter().find(|j| j.slug == name).map(|j| j.slug.clone()) {
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
            let mut qs = active_questions.lock().unwrap();
            qs.retain(|q| q.pane_id != pane_id);
            drop(qs);
            let _ = std::process::Command::new("tmux")
                .args(["send-keys", "-t", &pane_id, &answer, "Enter"])
                .output();
            event_sink.emit_questions_changed();
            IpcResponse::Ok
        }
        IpcCommand::SetProtectedPanes { pane_ids } => {
            *protected_panes.lock().unwrap() = pane_ids.into_iter().collect();
            IpcResponse::Ok
        }
        IpcCommand::DismissQuestion { pane_id } => {
            let mut qs = active_questions.lock().unwrap();
            qs.retain(|q| q.pane_id != pane_id);
            drop(qs);
            event_sink.emit_questions_changed();
            IpcResponse::Ok
        }
        IpcCommand::RunJobNow { name, params } => {
            let job = {
                let cfg = jobs_config.lock().unwrap();
                cfg.jobs
                    .iter()
                    .find(|j| j.slug == name || j.name == name)
                    .cloned()
            };
            let job = match job {
                Some(j) => j,
                None => return IpcResponse::Error(format!("Job not found: {}", name)),
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
                let st = job_status.lock().unwrap();
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
                let s = settings.lock().unwrap().clone();
                let j = jobs_config.lock().unwrap().jobs.clone();
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
    }
}

fn compute_relay_status(
    settings: &Arc<Mutex<AppSettings>>,
    secrets: &Arc<Mutex<SecretsManager>>,
    relay: &Arc<Mutex<Option<clawtab_lib::relay::RelayHandle>>>,
    relay_sub_required: &Arc<Mutex<bool>>,
    relay_auth_expired: &Arc<Mutex<bool>>,
) -> IpcRelayStatus {
    let relay_settings = settings.lock().unwrap().relay.clone().unwrap_or_default();
    let connected = relay.lock().map(|g| g.is_some()).unwrap_or(false);
    let subscription_required = *relay_sub_required
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let auth_expired = *relay_auth_expired
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let device_token_stored = !relay_settings.device_token.is_empty()
        || secrets
            .lock()
            .unwrap()
            .get("relay_device_token")
            .map(|t| !t.is_empty())
            .unwrap_or(false);
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
    let settings_guard = ctx.settings.lock().unwrap();
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
            .unwrap()
            .get("relay_device_token")
            .cloned()
            .unwrap_or_default()
    } else {
        yaml_token
    };
    if device_token.is_empty() {
        return Err("Device token not configured".to_string());
    }

    *relay_sub_required.lock().unwrap() = false;

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
