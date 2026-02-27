mod aerospace;
mod browser;
mod claude_usage;
mod commands;
mod config;
mod cwt;
mod history;
pub mod ipc;
mod questions;
mod relay;
mod scheduler;
mod secrets;
pub mod telegram;
mod terminal;
mod tmux;
mod tools;
mod updater;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    Manager,
};

use clawtab_protocol::ClaudeQuestion;

use config::jobs::{JobStatus, JobsConfig};
use config::settings::AppSettings;
use history::HistoryStore;
use ipc::{IpcCommand, IpcResponse};
use scheduler::SchedulerHandle;
use secrets::SecretsManager;

pub struct AppState {
    pub settings: Arc<Mutex<AppSettings>>,
    pub jobs_config: Arc<Mutex<JobsConfig>>,
    pub secrets: Arc<Mutex<SecretsManager>>,
    pub history: Arc<Mutex<HistoryStore>>,
    pub scheduler: Arc<Mutex<Option<SchedulerHandle>>>,
    pub job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    pub active_agents: Arc<Mutex<HashMap<i64, telegram::ActiveAgent>>>,
    pub relay: Arc<Mutex<Option<relay::RelayHandle>>>,
    pub relay_sub_required: Arc<Mutex<bool>>,
    pub active_questions: Arc<Mutex<Vec<ClaudeQuestion>>>,
}

fn handle_ipc_command(state: &AppState, cmd: IpcCommand) -> IpcResponse {
    match cmd {
        IpcCommand::Ping => IpcResponse::Pong,
        IpcCommand::ListJobs => {
            let jobs = state.jobs_config.lock().unwrap();
            let names: Vec<String> = jobs.jobs.iter().map(|j| j.name.clone()).collect();
            IpcResponse::Jobs(names)
        }
        IpcCommand::RunJob { name } => {
            let jobs = state.jobs_config.lock().unwrap();
            let job = jobs.jobs.iter().find(|j| j.name == name);
            match job {
                Some(job) => {
                    let job = job.clone();
                    let secrets = Arc::clone(&state.secrets);
                    let history = Arc::clone(&state.history);
                    let settings = Arc::clone(&state.settings);
                    let job_status = Arc::clone(&state.job_status);
                    let active_agents = Arc::clone(&state.active_agents);
                    let relay = Arc::clone(&state.relay);
                    tauri::async_runtime::spawn(async move {
                        scheduler::executor::execute_job(
                            &job,
                            &secrets,
                            &history,
                            &settings,
                            &job_status,
                            "cli",
                            &active_agents,
                            &relay,
                            &std::collections::HashMap::new(),
                        )
                        .await;
                    });
                    IpcResponse::Ok
                }
                None => IpcResponse::Error(format!("Job not found: {}", name)),
            }
        }
        IpcCommand::PauseJob { name } => {
            let mut status = state.job_status.lock().unwrap();
            match status.get(&name) {
                Some(config::jobs::JobStatus::Running { .. }) => {
                    status.insert(name, config::jobs::JobStatus::Paused);
                    IpcResponse::Ok
                }
                _ => IpcResponse::Error("Job is not running".to_string()),
            }
        }
        IpcCommand::ResumeJob { name } => {
            let mut status = state.job_status.lock().unwrap();
            match status.get(&name) {
                Some(config::jobs::JobStatus::Paused) => {
                    status.insert(name, config::jobs::JobStatus::Idle);
                    IpcResponse::Ok
                }
                _ => IpcResponse::Error("Job is not paused".to_string()),
            }
        }
        IpcCommand::RestartJob { name } => {
            let jobs = state.jobs_config.lock().unwrap();
            let job = jobs.jobs.iter().find(|j| j.name == name);
            match job {
                Some(job) => {
                    let job = job.clone();
                    let secrets = Arc::clone(&state.secrets);
                    let history = Arc::clone(&state.history);
                    let settings = Arc::clone(&state.settings);
                    let job_status = Arc::clone(&state.job_status);
                    let active_agents = Arc::clone(&state.active_agents);
                    let relay = Arc::clone(&state.relay);
                    tauri::async_runtime::spawn(async move {
                        scheduler::executor::execute_job(
                            &job,
                            &secrets,
                            &history,
                            &settings,
                            &job_status,
                            "restart",
                            &active_agents,
                            &relay,
                            &std::collections::HashMap::new(),
                        )
                        .await;
                    });
                    IpcResponse::Ok
                }
                None => IpcResponse::Error(format!("Job not found: {}", name)),
            }
        }
        IpcCommand::GetStatus => {
            let status = state.job_status.lock().unwrap().clone();
            IpcResponse::Status(status)
        }
        IpcCommand::OpenSettings => {
            // GUI-only command, handled by the Tauri app
            IpcResponse::Ok
        }
    }
}

fn init_file_logger() {
    use std::fs;

    let log_dir = std::path::Path::new("/tmp/clawtab");
    let _ = fs::create_dir_all(log_dir);
    let log_path = log_dir.join("engine.log");

    // Truncate on startup so the file doesn't grow forever
    let file = fs::File::create(&log_path).expect("failed to create engine.log");
    let file = std::sync::Mutex::new(file);

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_secs()
        .format(move |_buf, record| {
            use std::io::Write as _;
            let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
            let line = format!("{} [{}] {}\n", ts, record.level(), record.args());
            let mut f = file.lock().unwrap();
            f.write_all(line.as_bytes()).ok();
            f.flush().ok();
            Ok(())
        })
        .init();
}

pub fn run() {
    init_file_logger();

    log::info!("clawtab starting");

    let settings = Arc::new(Mutex::new(AppSettings::load()));
    let jobs_config = Arc::new(Mutex::new(JobsConfig::load()));
    let secrets = Arc::new(Mutex::new(SecretsManager::new()));
    let history = Arc::new(Mutex::new(
        HistoryStore::new().expect("failed to initialize history database"),
    ));

    // Ensure agent + per-job cwt.md context files are fresh on startup
    {
        let s = settings.lock().unwrap();
        let j = jobs_config.lock().unwrap();
        commands::jobs::ensure_agent_dir(&s, &j.jobs);
        commands::jobs::regenerate_all_cwt_contexts(&s, &j.jobs);
    }

    let job_status: Arc<Mutex<HashMap<String, JobStatus>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let active_agents: Arc<Mutex<HashMap<i64, telegram::ActiveAgent>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let relay_handle: Arc<Mutex<Option<relay::RelayHandle>>> = Arc::new(Mutex::new(None));
    let relay_sub_required: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let active_questions: Arc<Mutex<Vec<ClaudeQuestion>>> =
        Arc::new(Mutex::new(Vec::new()));

    let app_state = AppState {
        settings: Arc::clone(&settings),
        jobs_config: Arc::clone(&jobs_config),
        secrets: Arc::clone(&secrets),
        history: Arc::clone(&history),
        scheduler: Arc::new(Mutex::new(None)),
        job_status: Arc::clone(&job_status),
        active_agents: Arc::clone(&active_agents),
        relay: Arc::clone(&relay_handle),
        relay_sub_required: Arc::clone(&relay_sub_required),
        active_questions: Arc::clone(&active_questions),
    };

    // Clones for IPC handler
    let state_for_ipc = AppState {
        settings: Arc::clone(&settings),
        jobs_config: Arc::clone(&jobs_config),
        secrets: Arc::clone(&secrets),
        history: Arc::clone(&history),
        scheduler: Arc::clone(&app_state.scheduler),
        job_status: Arc::clone(&job_status),
        active_agents: Arc::clone(&active_agents),
        relay: Arc::clone(&relay_handle),
        relay_sub_required: Arc::clone(&relay_sub_required),
        active_questions: Arc::clone(&active_questions),
    };

    // Clones for scheduler
    let jobs_for_scheduler = Arc::clone(&jobs_config);
    let secrets_for_scheduler = Arc::clone(&secrets);
    let history_for_scheduler = Arc::clone(&history);
    let settings_for_scheduler = Arc::clone(&settings);
    let job_status_for_scheduler = Arc::clone(&job_status);
    let active_agents_for_scheduler = Arc::clone(&active_agents);
    let relay_for_scheduler = Arc::clone(&relay_handle);

    // Clones for reattach
    let jobs_for_reattach = Arc::clone(&jobs_config);
    let settings_for_reattach = Arc::clone(&settings);
    let job_status_for_reattach = Arc::clone(&job_status);
    let history_for_reattach = Arc::clone(&history);
    let active_agents_for_reattach = Arc::clone(&active_agents);
    let relay_for_reattach = Arc::clone(&relay_handle);

    // Clones for relay
    let relay_for_setup = Arc::clone(&relay_handle);
    let relay_sub_for_setup = Arc::clone(&relay_sub_required);
    let settings_for_relay = Arc::clone(&settings);
    let jobs_for_relay = Arc::clone(&jobs_config);
    let job_status_for_relay = Arc::clone(&job_status);
    let secrets_for_relay = Arc::clone(&secrets);
    let history_for_relay = Arc::clone(&history);
    let active_agents_for_relay = Arc::clone(&active_agents);

    // Clones for question detection loop
    let jobs_for_questions = Arc::clone(&jobs_config);
    let job_status_for_questions = Arc::clone(&job_status);
    let relay_for_questions = Arc::clone(&relay_handle);
    let active_questions_for_loop = Arc::clone(&active_questions);

    // Clones for update checker
    let settings_for_updater = Arc::clone(&settings);

    // Clones for telegram agent
    let telegram_agent_state = telegram::polling::AgentState {
        settings: Arc::clone(&settings),
        jobs_config: Arc::clone(&jobs_config),
        secrets: Arc::clone(&secrets),
        history: Arc::clone(&history),
        job_status: Arc::clone(&job_status),
        active_agents: Arc::clone(&active_agents),
        relay: Arc::clone(&relay_handle),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::jobs::get_jobs,
            commands::jobs::save_job,
            commands::jobs::delete_job,
            commands::jobs::toggle_job,
            commands::jobs::run_job_now,
            commands::jobs::pause_job,
            commands::jobs::resume_job,
            commands::jobs::stop_job,
            commands::jobs::restart_job,
            commands::jobs::run_agent,
            commands::jobs::get_agent_dir,
            commands::jobs::open_job_editor,
            commands::jobs::open_job_in_editor,
            commands::jobs::init_cwt_folder,
            commands::jobs::read_cwt_entry,
            commands::jobs::write_cwt_entry,
            commands::jobs::read_cwt_context,
            commands::jobs::derive_job_slug,
            commands::secrets::list_secrets,
            commands::secrets::set_secret,
            commands::secrets::delete_secret,
            commands::secrets::gopass_available,
            commands::secrets::list_gopass_store,
            commands::secrets::fetch_gopass_value,
            commands::history::get_history,
            commands::history::get_run_detail,
            commands::history::get_job_runs,
            commands::history::open_run_log,
            commands::history::delete_run,
            commands::history::delete_runs,
            commands::history::clear_history,
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::settings::write_editor_log,
            commands::settings::show_settings_window,
            commands::settings::get_hostname,
            commands::settings::open_logs_folder,
            commands::status::get_job_statuses,
            commands::status::get_running_job_logs,
            commands::status::send_job_input,
            commands::tmux::list_tmux_sessions,
            commands::tmux::list_tmux_windows,
            commands::tmux::focus_job_window,
            commands::tmux::open_job_terminal,
            commands::tools::detect_tools,
            commands::tools::install_tool,
            commands::tools::set_tool_path,
            commands::skills::list_skills,
            commands::skills::read_skill,
            commands::skills::write_skill,
            commands::skills::delete_skill,
            commands::skills::open_skill_in_editor,
            commands::aerospace::aerospace_available,
            commands::aerospace::list_aerospace_workspaces,
            commands::telegram::get_telegram_config,
            commands::telegram::set_telegram_config,
            commands::telegram::test_telegram,
            commands::telegram::validate_bot_token,
            commands::telegram::reset_poll_offset,
            commands::telegram::stop_setup_polling,
            commands::telegram::poll_telegram_updates,
            commands::browser::launch_browser_auth,
            commands::browser::check_browser_session,
            commands::browser::clear_browser_session,
            commands::browser::check_playwright_installed,
            commands::updater::get_version,
            commands::updater::check_for_update,
            commands::updater::restart_app,
            commands::claude_usage::get_claude_usage,
            commands::relay::get_relay_settings,
            commands::relay::set_relay_settings,
            commands::relay::get_relay_status,
            commands::relay::relay_login,
            commands::relay::relay_pair_device,
            commands::relay::relay_disconnect,
            commands::relay::relay_connect,
            commands::relay::relay_save_tokens,
            commands::relay::relay_check_subscription,
            commands::processes::detect_claude_processes,
            commands::processes::focus_detected_process,
            commands::processes::get_detected_process_logs,
            commands::processes::send_detected_process_input,
            commands::processes::get_active_questions,
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let settings_item =
                MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let session_item =
                MenuItem::with_id(app, "usage_session", "Session: --%", false, None::<&str>)?;
            let week_item =
                MenuItem::with_id(app, "usage_week", "Week: --%", false, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&settings_item, &sep1, &session_item, &week_item, &sep2, &quit_item],
            )?;

            let session_handle = session_item.clone();
            let week_handle = week_item.clone();

            if let Some(tray) = app.tray_by_id("main") {
                tray.set_menu(Some(menu))?;
                tray.on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => {
                        if let Some(window) = app.get_webview_window("settings") {
                            #[cfg(target_os = "macos")]
                            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                });
            }

            // Background task: refresh Claude usage stats every 5 minutes
            tauri::async_runtime::spawn(async move {
                loop {
                    match claude_usage::fetch_usage().await {
                        Ok(usage) => {
                            let session_text = match usage.five_hour {
                                Some(ref b) => match b.resets_in_human() {
                                    Some(t) => format!("Session: {:.0}% (resets {})", b.utilization, t),
                                    None => format!("Session: {:.0}%", b.utilization),
                                },
                                None => "Session: n/a".to_string(),
                            };
                            let week_text = match usage.seven_day {
                                Some(ref b) => match b.resets_in_human() {
                                    Some(t) => format!("Week: {:.0}% (resets {})", b.utilization, t),
                                    None => format!("Week: {:.0}%", b.utilization),
                                },
                                None => "Week: n/a".to_string(),
                            };
                            let _ = session_handle.set_text(session_text);
                            let _ = week_handle.set_text(week_text);
                        }
                        Err(e) => {
                            log::warn!("Claude usage fetch failed: {}", e);
                            let _ = session_handle.set_text("Session: n/a");
                            let _ = week_handle.set_text("Week: n/a");
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(5 * 60)).await;
                }
            });

            // Hide settings window on close instead of quitting
            if let Some(settings_window) = app.get_webview_window("settings") {
                let window = settings_window.clone();
                let app_handle = app.handle().clone();
                settings_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window.hide();
                        #[cfg(target_os = "macos")]
                        let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                });
            }

            // Start IPC server
            tauri::async_runtime::spawn(async move {
                let handler = move |cmd: IpcCommand| -> IpcResponse {
                    handle_ipc_command(&state_for_ipc, cmd)
                };
                if let Err(e) = ipc::start_ipc_server(handler).await {
                    log::error!("IPC server error: {}", e);
                }
            });

            // Start scheduler
            let handle = scheduler::start(
                jobs_for_scheduler,
                secrets_for_scheduler,
                history_for_scheduler,
                settings_for_scheduler,
                job_status_for_scheduler,
                active_agents_for_scheduler,
                relay_for_scheduler,
            );
            {
                let state: tauri::State<AppState> = app.state();
                *state.scheduler.lock().unwrap() = Some(handle);
            }

            // Reattach jobs still running in tmux from previous session
            tauri::async_runtime::spawn(async move {
                scheduler::reattach::reattach_running_jobs(
                    &jobs_for_reattach,
                    &settings_for_reattach,
                    &job_status_for_reattach,
                    &history_for_reattach,
                    &active_agents_for_reattach,
                    &relay_for_reattach,
                );
            });

            // Start relay connection if configured
            {
                let relay_settings = settings_for_relay.lock().unwrap().relay.clone();
                if let Some(rs) = relay_settings {
                    // Read device_token from yaml, fall back to keychain
                    let device_token = if rs.device_token.is_empty() {
                        secrets_for_relay.lock().unwrap()
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
                        let server_url_for_sub = rs.server_url.clone();
                        tauri::async_runtime::spawn(async move {
                            relay::connect_loop(
                                ws_url,
                                device_token,
                                server_url_for_sub,
                                relay_for_setup,
                                relay_sub_for_setup,
                                jobs_for_relay,
                                job_status_for_relay,
                                secrets_for_relay,
                                history_for_relay,
                                settings_for_relay,
                                active_agents_for_relay,
                            )
                            .await;
                        });
                    }
                }
            }

            // Start question detection loop
            tauri::async_runtime::spawn(async move {
                questions::question_detection_loop(
                    jobs_for_questions,
                    job_status_for_questions,
                    relay_for_questions,
                    active_questions_for_loop,
                )
                .await;
            });

            // Start telegram agent polling
            tauri::async_runtime::spawn(async move {
                log::info!("Telegram polling task spawned");
                telegram::polling::start_polling(telegram_agent_state).await;
                log::error!("Telegram polling loop exited unexpectedly");
            });

            // Start auto-update checker
            updater::start_update_checker(app.handle().clone(), settings_for_updater);

            log::info!("clawtab setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
