use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use clawtab_lib::config::jobs::{JobStatus, JobsConfig};
use clawtab_lib::config::settings::AppSettings;
use clawtab_lib::events::NoopEventSink;
use clawtab_lib::history::HistoryStore;
use clawtab_lib::ipc::{self, IpcCommand, IpcResponse};
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
    let active_questions: Arc<Mutex<Vec<clawtab_protocol::ClaudeQuestion>>> =
        Arc::new(Mutex::new(Vec::new()));
    let auto_yes_panes: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let protected_panes: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let notification_state: Arc<Mutex<clawtab_lib::notifications::NotificationState>> = Arc::new(
        Mutex::new(clawtab_lib::notifications::NotificationState::new()),
    );
    let pty_manager: clawtab_lib::pty::SharedPtyManager =
        Arc::new(Mutex::new(clawtab_lib::pty::PtyManager::new()));

    let event_sink: Arc<dyn clawtab_lib::events::EventSink> = Arc::new(NoopEventSink);
    let notifier: Arc<dyn clawtab_lib::notifications::Notifier> = Arc::new(OsascriptNotifier);

    let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    rt.block_on(async {
        // IPC server
        {
            let jobs_config = Arc::clone(&jobs_config);
            let secrets = Arc::clone(&secrets);
            let history = Arc::clone(&history);
            let settings = Arc::clone(&settings);
            let job_status = Arc::clone(&job_status);
            let active_agents = Arc::clone(&active_agents);
            let relay = Arc::clone(&relay_handle);
            let auto_yes_panes = Arc::clone(&auto_yes_panes);
            let active_questions = Arc::clone(&active_questions);
            tokio::spawn(async move {
                let handler = move |cmd: IpcCommand| -> IpcResponse {
                    handle_ipc_command(
                        &jobs_config,
                        &secrets,
                        &history,
                        &settings,
                        &job_status,
                        &active_agents,
                        &relay,
                        &auto_yes_panes,
                        &active_questions,
                        cmd,
                    )
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
            Arc::clone(&secrets),
            Arc::clone(&history),
            Arc::clone(&settings),
            Arc::clone(&job_status),
            Arc::clone(&active_agents),
            Arc::clone(&relay_handle),
            Arc::clone(&auto_yes_panes),
            Arc::clone(&protected_panes),
        ));

        // Reattach jobs still running in tmux from previous session
        {
            let event_sink = Arc::clone(&event_sink);
            let jobs_config = Arc::clone(&jobs_config);
            let settings = Arc::clone(&settings);
            let job_status = Arc::clone(&job_status);
            let history = Arc::clone(&history);
            let active_agents = Arc::clone(&active_agents);
            let relay = Arc::clone(&relay_handle);
            let auto_yes_panes = Arc::clone(&auto_yes_panes);
            let protected_panes = Arc::clone(&protected_panes);
            tokio::spawn(async move {
                clawtab_lib::scheduler::reattach::reattach_running_jobs(
                    event_sink.as_ref(),
                    &jobs_config,
                    &settings,
                    &job_status,
                    &history,
                    &active_agents,
                    &relay,
                    &auto_yes_panes,
                    &protected_panes,
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
                    let relay = Arc::clone(&relay_handle);
                    let relay_sub = Arc::clone(&relay_sub_required);
                    let jobs_config = Arc::clone(&jobs_config);
                    let job_status = Arc::clone(&job_status);
                    let secrets = Arc::clone(&secrets);
                    let history = Arc::clone(&history);
                    let settings = Arc::clone(&settings);
                    let active_agents = Arc::clone(&active_agents);
                    let auto_yes_panes = Arc::clone(&auto_yes_panes);
                    let pty_manager = Arc::clone(&pty_manager);
                    let event_sink = Arc::clone(&event_sink);
                    tokio::spawn(async move {
                        clawtab_lib::relay::connect_loop(
                            ws_url,
                            device_token,
                            server_url,
                            relay,
                            relay_sub,
                            jobs_config,
                            job_status,
                            secrets,
                            history,
                            settings,
                            active_agents,
                            auto_yes_panes,
                            pty_manager,
                            event_sink,
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
                secrets: Arc::clone(&secrets),
                history: Arc::clone(&history),
                job_status: Arc::clone(&job_status),
                active_agents: Arc::clone(&active_agents),
                relay: Arc::clone(&relay_handle),
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

fn handle_ipc_command(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    secrets: &Arc<Mutex<SecretsManager>>,
    history: &Arc<Mutex<HistoryStore>>,
    settings: &Arc<Mutex<AppSettings>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    active_agents: &Arc<Mutex<HashMap<i64, telegram::ActiveAgent>>>,
    relay: &Arc<Mutex<Option<clawtab_lib::relay::RelayHandle>>>,
    auto_yes_panes: &Arc<Mutex<HashSet<String>>>,
    active_questions: &Arc<Mutex<Vec<clawtab_protocol::ClaudeQuestion>>>,
    cmd: IpcCommand,
) -> IpcResponse {
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
                    let secrets = Arc::clone(secrets);
                    let history = Arc::clone(history);
                    let settings = Arc::clone(settings);
                    let job_status = Arc::clone(job_status);
                    let active_agents = Arc::clone(active_agents);
                    let relay = Arc::clone(relay);
                    tokio::spawn(async move {
                        clawtab_lib::scheduler::executor::execute_job(
                            &job,
                            &secrets,
                            &history,
                            &settings,
                            &job_status,
                            "cli",
                            &active_agents,
                            &relay,
                            &HashMap::new(),
                            None,
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
                    let secrets = Arc::clone(secrets);
                    let history = Arc::clone(history);
                    let settings = Arc::clone(settings);
                    let job_status = Arc::clone(job_status);
                    let active_agents = Arc::clone(active_agents);
                    let relay = Arc::clone(relay);
                    tokio::spawn(async move {
                        clawtab_lib::scheduler::executor::execute_job(
                            &job,
                            &secrets,
                            &history,
                            &settings,
                            &job_status,
                            "restart",
                            &active_agents,
                            &relay,
                            &HashMap::new(),
                            None,
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
    }
}
