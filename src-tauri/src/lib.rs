mod commands;
mod config;
mod history;
pub mod ipc;
mod scheduler;
mod secrets;
mod tools;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{
    menu::{Menu, MenuItem},
    Manager,
};

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
                    tauri::async_runtime::spawn(async move {
                        scheduler::executor::execute_job(
                            &job,
                            &secrets,
                            &history,
                            &settings,
                            &job_status,
                            "cli",
                        )
                        .await;
                    });
                    IpcResponse::Ok
                }
                None => IpcResponse::Error(format!("Job not found: {}", name)),
            }
        }
    }
}

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_secs()
        .init();

    log::info!("clawdtab starting");

    let settings = Arc::new(Mutex::new(AppSettings::load()));
    let jobs_config = Arc::new(Mutex::new(JobsConfig::load()));
    let secrets = Arc::new(Mutex::new(SecretsManager::new()));
    let history = Arc::new(Mutex::new(
        HistoryStore::new().expect("failed to initialize history database"),
    ));

    let job_status: Arc<Mutex<HashMap<String, JobStatus>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let app_state = AppState {
        settings: Arc::clone(&settings),
        jobs_config: Arc::clone(&jobs_config),
        secrets: Arc::clone(&secrets),
        history: Arc::clone(&history),
        scheduler: Arc::new(Mutex::new(None)),
        job_status: Arc::clone(&job_status),
    };

    // Clones for IPC handler
    let state_for_ipc = AppState {
        settings: Arc::clone(&settings),
        jobs_config: Arc::clone(&jobs_config),
        secrets: Arc::clone(&secrets),
        history: Arc::clone(&history),
        scheduler: Arc::clone(&app_state.scheduler),
        job_status: Arc::clone(&job_status),
    };

    // Clones for scheduler
    let jobs_for_scheduler = Arc::clone(&jobs_config);
    let secrets_for_scheduler = Arc::clone(&secrets);
    let history_for_scheduler = Arc::clone(&history);
    let settings_for_scheduler = Arc::clone(&settings);
    let job_status_for_scheduler = Arc::clone(&job_status);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::jobs::get_jobs,
            commands::jobs::save_job,
            commands::jobs::delete_job,
            commands::jobs::toggle_job,
            commands::jobs::run_job_now,
            commands::secrets::list_secrets,
            commands::secrets::set_secret,
            commands::secrets::delete_secret,
            commands::history::get_history,
            commands::history::get_run_detail,
            commands::history::clear_history,
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::status::get_job_statuses,
            commands::tools::detect_tools,
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let settings_item =
                MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

            if let Some(tray) = app.tray_by_id("main") {
                tray.set_menu(Some(menu))?;
                tray.on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => {
                        if let Some(window) = app.get_webview_window("settings") {
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

            // Hide settings window on close instead of quitting
            if let Some(settings_window) = app.get_webview_window("settings") {
                let window = settings_window.clone();
                settings_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window.hide();
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
            );
            {
                let state: tauri::State<AppState> = app.state();
                *state.scheduler.lock().unwrap() = Some(handle);
            }

            log::info!("clawdtab setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
