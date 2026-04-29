// In daemon mode, lib is compiled as a dependency but many items are only
// used by the daemon binary entry point, not re-exported from lib. Allow
// dead_code so these don't trigger -D unused. Desktop mode uses everything.
#![cfg_attr(not(feature = "desktop"), allow(dead_code, unused_imports))]

mod aerospace;
pub mod agent;
pub mod agent_session;
#[cfg(feature = "desktop")]
mod browser;
mod claude_usage;
#[cfg(feature = "desktop")]
mod commands;
pub mod config;
mod cwt;
pub mod daemon;
mod debug_spawn;
pub mod events;
pub mod history;
pub mod ipc;
pub mod job_context;
pub mod notifications;
pub mod pty;
pub mod questions;
pub mod relay;
pub mod scheduler;
pub mod secrets;
pub mod telegram;
mod terminal;
pub mod tmux;
mod tools;
#[cfg(feature = "desktop")]
mod updater;
mod usage;
pub mod watcher;

// Everything below this point is desktop-only (Tauri GUI app).
// The daemon binary uses individual modules directly.
#[cfg(feature = "desktop")]
use std::collections::{HashMap, HashSet};
#[cfg(feature = "desktop")]
use std::sync::{Arc, Mutex};

#[cfg(feature = "desktop")]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};

#[cfg(feature = "desktop")]
use clawtab_protocol::ClaudeQuestion;

#[cfg(feature = "desktop")]
use config::jobs::{JobStatus, JobsConfig};
#[cfg(feature = "desktop")]
use config::settings::{AppSettings, ShortcutSettings};
#[cfg(feature = "desktop")]
use history::HistoryStore;
#[cfg(feature = "desktop")]
use secrets::SecretsManager;

#[cfg(feature = "desktop")]
pub struct AppState {
    pub settings: Arc<Mutex<AppSettings>>,
    pub jobs_config: Arc<Mutex<JobsConfig>>,
    pub secrets: Arc<Mutex<SecretsManager>>,
    pub history: Arc<Mutex<HistoryStore>>,
    pub scheduler: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    pub job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    pub active_agents: Arc<Mutex<HashMap<i64, telegram::ActiveAgent>>>,
    pub relay: Arc<Mutex<Option<relay::RelayHandle>>>,
    pub relay_sub_required: Arc<Mutex<bool>>,
    pub relay_auth_expired: Arc<Mutex<bool>>,
    pub active_questions: Arc<Mutex<Vec<ClaudeQuestion>>>,
    pub auto_yes_panes: Arc<Mutex<HashSet<String>>>,
    pub protected_panes: Arc<Mutex<HashSet<String>>>,
    pub process_overrides: Arc<Mutex<HashMap<String, config::settings::DetectedProcessOverride>>>,
    pub notification_state: Arc<Mutex<notifications::NotificationState>>,
    pub app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
    pub pty_manager: pty::SharedPtyManager,
}

#[cfg(feature = "desktop")]
const MENU_SHORTCUT_RENAME_ACTIVE_PANE: &str = "shortcut_rename_active_pane";
#[cfg(feature = "desktop")]
const MENU_SHORTCUT_FOCUS_AGENT_INPUT: &str = "shortcut_focus_agent_input";
#[cfg(feature = "desktop")]
const MENU_SHORTCUT_ZOOM_ACTIVE_PANE: &str = "shortcut_zoom_active_pane";
#[cfg(feature = "desktop")]
const MENU_SHORTCUT_TOGGLE_AUTO_YES: &str = "shortcut_toggle_auto_yes";

#[cfg(feature = "desktop")]
fn shortcut_binding_to_accelerator(binding: &str) -> Option<String> {
    let trimmed = binding.trim();
    if trimmed.is_empty()
        || trimmed.to_ascii_lowercase().contains("prefix")
        || trimmed.contains(' ')
    {
        return None;
    }

    let mut parts = trimmed
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .peekable();
    let mut normalized: Vec<String> = Vec::new();
    let mut key: Option<String> = None;

    while let Some(part) = parts.next() {
        let lower = part.to_ascii_lowercase();
        match lower.as_str() {
            "meta" | "cmd" | "command" => normalized.push("CmdOrCtrl".to_string()),
            "ctrl" | "control" => normalized.push("Ctrl".to_string()),
            "alt" | "option" => normalized.push("Alt".to_string()),
            "shift" => normalized.push("Shift".to_string()),
            "up" => key = Some("ArrowUp".to_string()),
            "down" => key = Some("ArrowDown".to_string()),
            "left" => key = Some("ArrowLeft".to_string()),
            "right" => key = Some("ArrowRight".to_string()),
            "space" => key = Some("Space".to_string()),
            "tab" => key = Some("Tab".to_string()),
            "enter" | "return" => key = Some("Enter".to_string()),
            "esc" | "escape" => key = Some("Escape".to_string()),
            _ if part.len() == 1 => {
                let ch = part.chars().next()?;
                if ch.is_ascii_alphanumeric() {
                    key = Some(ch.to_ascii_uppercase().to_string());
                } else {
                    return None;
                }
            }
            _ => return None,
        }
    }

    key.map(|key_part| {
        normalized.push(key_part);
        normalized.join("+")
    })
}

#[cfg(feature = "desktop")]
fn open_debug_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("debug") {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        log::warn!("debug window not registered in tauri.conf.json");
    }
}

#[cfg(feature = "desktop")]
fn open_pty_debug_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("pty_debug") {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        log::warn!("pty_debug window not registered in tauri.conf.json");
    }
}

#[cfg(feature = "desktop")]
fn find_submenu(menu: &Menu<tauri::Wry>, title: &str) -> Option<Submenu<tauri::Wry>> {
    menu.items().ok()?.into_iter().find_map(|item| {
        item.as_submenu()
            .filter(|submenu| submenu.text().ok().as_deref() == Some(title))
            .cloned()
    })
}

#[cfg(feature = "desktop")]
fn find_menu_item(submenu: &Submenu<tauri::Wry>, label: &str) -> Option<MenuItem<tauri::Wry>> {
    submenu.items().ok()?.into_iter().find_map(|item| {
        item.as_menuitem()
            .filter(|entry| entry.text().ok().as_deref() == Some(label))
            .cloned()
    })
}

#[cfg(feature = "desktop")]
pub(crate) fn refresh_tray_usage_menu(
    app: &tauri::AppHandle,
    snapshot: Option<&usage::UsageSnapshot>,
) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id("main") else {
        return Ok(());
    };

    let show_tray_icon = app
        .try_state::<AppState>()
        .map(|state| state.settings.lock().unwrap().show_tray_icon)
        .unwrap_or(true);
    tray.set_visible(show_tray_icon)?;

    let settings_item = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let (claude, codex, zai) = tray_usage_labels(snapshot);
    let claude_item = MenuItem::with_id(app, "usage_claude", claude, false, None::<&str>)?;
    let codex_item = MenuItem::with_id(app, "usage_codex", codex, false, None::<&str>)?;
    let zai_item = MenuItem::with_id(app, "usage_zai", zai, false, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let tray_menu = Menu::with_items(
        app,
        &[
            &settings_item,
            &sep1,
            &claude_item,
            &codex_item,
            &zai_item,
            &sep2,
            &quit_item,
        ],
    )?;
    tray.set_menu(Some(tray_menu))
}

#[cfg(feature = "desktop")]
fn tray_usage_labels(snapshot: Option<&usage::UsageSnapshot>) -> (String, String, String) {
    match snapshot {
        Some(snapshot) => (
            format!("Claude: {}", snapshot.claude.summary),
            format!("Codex: {}", snapshot.codex.summary),
            format!("z.ai: {}", snapshot.zai.summary),
        ),
        None => (
            "Claude: loading...".to_string(),
            "Codex: loading...".to_string(),
            "z.ai: loading...".to_string(),
        ),
    }
}

#[cfg(feature = "desktop")]
fn ensure_shortcut_menu_item(
    app: &tauri::AppHandle,
    submenu: &Submenu<tauri::Wry>,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    if let Some(existing) = find_menu_item(submenu, label) {
        existing.set_accelerator(accelerator)?;
        return Ok(existing);
    }
    let item = MenuItem::with_id(app, id, label, true, accelerator)?;
    submenu.append(&item)?;
    Ok(item)
}

#[cfg(feature = "desktop")]
pub fn refresh_shortcut_menu(
    app: &tauri::AppHandle,
    shortcuts: &ShortcutSettings,
) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };

    let pane_menu = if let Some(existing) = find_submenu(&menu, "Pane") {
        existing
    } else {
        let submenu = Submenu::with_id(app, "pane_menu", "Pane", true)?;
        menu.append(&submenu)?;
        submenu
    };

    let rename_accel = shortcut_binding_to_accelerator(&shortcuts.rename_active_pane);
    let focus_accel = shortcut_binding_to_accelerator(&shortcuts.focus_agent_input);
    let zoom_accel = shortcut_binding_to_accelerator(&shortcuts.zoom_active_pane);
    let toggle_auto_yes_accel = shortcut_binding_to_accelerator(&shortcuts.toggle_auto_yes);
    log::info!(
        "refresh_shortcut_menu: toggle_auto_yes binding={:?} accel={:?}",
        shortcuts.toggle_auto_yes,
        toggle_auto_yes_accel
    );

    let _ = ensure_shortcut_menu_item(
        app,
        &pane_menu,
        MENU_SHORTCUT_RENAME_ACTIVE_PANE,
        "Rename Active Pane",
        rename_accel.as_deref(),
    )?;
    let _ = ensure_shortcut_menu_item(
        app,
        &pane_menu,
        MENU_SHORTCUT_FOCUS_AGENT_INPUT,
        "Focus Agent Input",
        focus_accel.as_deref(),
    )?;
    let _ = ensure_shortcut_menu_item(
        app,
        &pane_menu,
        MENU_SHORTCUT_ZOOM_ACTIVE_PANE,
        "Zoom Active Pane",
        zoom_accel.as_deref(),
    )?;
    let _ = ensure_shortcut_menu_item(
        app,
        &pane_menu,
        MENU_SHORTCUT_TOGGLE_AUTO_YES,
        "Toggle Auto-yes",
        toggle_auto_yes_accel.as_deref(),
    )?;

    Ok(())
}

#[cfg(feature = "desktop")]
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

#[cfg(feature = "desktop")]
pub fn run() {
    // Unset TMUX so child tmux commands connect to the default server,
    // not the overmind/nested server this process may have been launched from.
    std::env::remove_var("TMUX");

    init_file_logger();

    log::info!("clawtab starting");

    if let Err(e) = debug_spawn::init() {
        log::warn!("debug_spawn init failed: {}", e);
    }

    let settings = Arc::new(Mutex::new(AppSettings::load()));
    let jobs_config = Arc::new(Mutex::new(JobsConfig::load()));
    let secrets = Arc::new(Mutex::new(SecretsManager::new()));
    let history = Arc::new(Mutex::new(
        HistoryStore::new().expect("failed to initialize history database"),
    ));

    // Run startup migrations
    {
        let mut j = jobs_config.lock().unwrap();
        config::jobs::migrate_job_md_to_central(&mut j.jobs);
        config::jobs::migrate_cwt_to_central(&j.jobs);
    }

    // Ensure agent + per-job cwt.md context files are fresh on startup
    {
        let s = settings.lock().unwrap();
        let j = jobs_config.lock().unwrap();
        commands::jobs::ensure_agent_dir(&s, &j.jobs);
        commands::jobs::regenerate_all_cwt_contexts(&s, &j.jobs);
    }

    let job_status: Arc<Mutex<HashMap<String, JobStatus>>> = Arc::new(Mutex::new(HashMap::new()));
    let active_agents: Arc<Mutex<HashMap<i64, telegram::ActiveAgent>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let relay_handle: Arc<Mutex<Option<relay::RelayHandle>>> = Arc::new(Mutex::new(None));
    let relay_sub_required: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let relay_auth_expired: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let active_questions: Arc<Mutex<Vec<ClaudeQuestion>>> = Arc::new(Mutex::new(Vec::new()));
    let auto_yes_panes: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let protected_panes: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let process_overrides: Arc<Mutex<HashMap<String, config::settings::DetectedProcessOverride>>> = {
        let loaded = settings.lock().unwrap().process_overrides.clone();
        Arc::new(Mutex::new(loaded))
    };
    let notification_state: Arc<Mutex<notifications::NotificationState>> =
        Arc::new(Mutex::new(notifications::NotificationState::new()));

    let ipc_app_handle: Arc<Mutex<Option<tauri::AppHandle>>> = Arc::new(Mutex::new(None));
    let pty_manager: pty::SharedPtyManager = Arc::new(Mutex::new(pty::PtyManager::new()));

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
        relay_auth_expired: Arc::clone(&relay_auth_expired),
        active_questions: Arc::clone(&active_questions),
        auto_yes_panes: Arc::clone(&auto_yes_panes),
        protected_panes: Arc::clone(&protected_panes),
        process_overrides: Arc::clone(&process_overrides),
        notification_state: Arc::clone(&notification_state),
        app_handle: Arc::clone(&ipc_app_handle),
        pty_manager: Arc::clone(&pty_manager),
    };

    let settings_for_updater = Arc::clone(&settings);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::jobs::get_jobs,
            commands::jobs::get_cached_jobs_snapshot,
            commands::jobs::save_cached_jobs_snapshot,
            commands::jobs::save_job,
            commands::jobs::rename_job,
            commands::jobs::import_job_folder,
            commands::jobs::duplicate_job,
            commands::jobs::delete_job,
            commands::jobs::toggle_job,
            commands::jobs::run_job_now,
            commands::jobs::pause_job,
            commands::jobs::resume_job,
            commands::jobs::sigint_job,
            commands::jobs::stop_job,
            commands::jobs::restart_job,
            commands::jobs::run_agent,
            commands::jobs::open_agent_editor,
            commands::jobs::read_agent_context,
            commands::jobs::open_job_editor,
            commands::jobs::open_job_in_editor,
            commands::jobs::init_cwt_folder,
            commands::jobs::read_cwt_entry,
            commands::jobs::read_cwt_entry_at,
            commands::jobs::write_cwt_entry,
            commands::jobs::write_cwt_entry_at,
            commands::jobs::read_cwt_context,
            commands::jobs::read_cwt_context_at,
            commands::jobs::read_cwt_shared,
            commands::jobs::read_cwt_shared_at,
            commands::jobs::write_cwt_shared,
            commands::jobs::write_cwt_shared_at,
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
            commands::tmux::fork_pane,
            commands::tmux::split_pane_plain,
            commands::tmux::enter_copy_mode,
            commands::tools::detect_tools,
            commands::tools::detect_agent_providers,
            commands::tools::detect_opencode_models,
            commands::tools::detect_claude_models,
            commands::tools::detect_codex_models,
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
            commands::settings::set_dock_visibility,
            commands::settings::set_titlebar_visibility,
            commands::settings::set_tray_icon_visibility,
            commands::updater::get_version,
            commands::updater::check_for_update,
            commands::updater::restart_app,
            commands::claude_usage::get_claude_usage,
            commands::usage::get_usage_snapshot,
            commands::relay::get_relay_settings,
            commands::relay::set_relay_settings,
            commands::relay::get_relay_status,
            commands::relay::relay_login,
            commands::relay::relay_pair_device,
            commands::relay::relay_sign_out,
            commands::relay::relay_disconnect,
            commands::relay::relay_connect,
            commands::relay::relay_save_tokens,
            commands::relay::relay_get_pending_token,
            commands::relay::relay_check_subscription,
            commands::relay::relay_get_shares,
            commands::relay::relay_add_share,
            commands::relay::relay_update_share,
            commands::relay::relay_remove_share,
            commands::relay::relay_get_groups,
            commands::processes::detect_processes,
            commands::processes::focus_detected_process,
            commands::processes::get_detected_process_logs,
            commands::processes::send_detected_process_input,
            commands::processes::get_active_questions,
            commands::processes::get_auto_yes_panes,
            commands::processes::set_auto_yes_panes,
            commands::processes::set_protected_panes,
            commands::processes::set_detected_process_display_name,
            commands::processes::set_detected_process_group,
            commands::processes::set_detected_process_queries,
            commands::processes::sigint_detected_process,
            commands::processes::stop_detected_process,
            commands::processes::get_existing_pane_info,
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_destroy,
            commands::pty::pty_get_cached_output,
            commands::pty::pty_refresh_snapshot,
            commands::pty::pty_release,
            commands::pty::list_free_panes,
            commands::pty::list_captured_panes,
            commands::debug::debug_spawn_list,
            commands::debug::debug_spawn_summary,
            commands::debug::debug_spawn_clear,
            commands::daemon::get_daemon_status,
            commands::daemon::daemon_install,
            commands::daemon::daemon_uninstall,
            commands::daemon::daemon_restart,
            commands::daemon::get_daemon_logs,
        ])
        .setup(move |app| {
            // Show in Dock by default; if user disabled it, switch to Accessory (tray-only)
            #[cfg(target_os = "macos")]
            {
                let state = app.state::<AppState>();
                let settings = state.settings.lock().unwrap();
                let show = settings.show_in_dock;
                let hide_titlebar = settings.hide_titlebar;
                drop(settings);
                if !show {
                    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
                // Config defaults to Overlay; restore Visible if user disabled it
                if !hide_titlebar {
                    if let Some(window) = app.get_webview_window("settings") {
                        let _ = window.set_title_bar_style(tauri::TitleBarStyle::Visible);
                    }
                }
            }

            // Set app handle for IPC
            *ipc_app_handle.lock().unwrap() = Some(app.handle().clone());

            // Tray menu
            let secrets_for_usage = app.state::<AppState>().secrets.clone();
            let app_for_usage = app.handle().clone();

            if let Some(tray) = app.tray_by_id("main") {
                refresh_tray_usage_menu(app.handle(), None)?;
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
                        app.state::<AppState>()
                            .pty_manager
                            .lock()
                            .unwrap()
                            .destroy_all();
                        app.exit(0);
                    }
                    _ => {}
                });
            }

            // Build app menu manually so we can omit Redo (Cmd+Y) which would
            // otherwise shadow our custom Toggle Auto-yes shortcut.
            let pkg_info = app.package_info();
            let config = app.config();
            let about_metadata = tauri::menu::AboutMetadata {
                name: Some(pkg_info.name.clone()),
                version: Some(pkg_info.version.to_string()),
                copyright: config.bundle.copyright.clone(),
                authors: config.bundle.publisher.clone().map(|p| vec![p]),
                ..Default::default()
            };
            let import_item =
                MenuItem::with_id(app, "import_cwt", "Import Job...", true, None::<&str>)?;
            let debug_item = MenuItem::with_id(app, "view_debug", "Debug", true, None::<&str>)?;
            let pty_debug_item =
                MenuItem::with_id(app, "view_pty_debug", "PTY Debug", true, None::<&str>)?;
            let app_menu = Menu::with_items(
                app,
                &[
                    &Submenu::with_items(
                        app,
                        pkg_info.name.clone(),
                        true,
                        &[
                            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::services(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::hide(app, None)?,
                            &PredefinedMenuItem::hide_others(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::quit(app, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "File",
                        true,
                        &[
                            &PredefinedMenuItem::close_window(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &import_item,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Edit",
                        true,
                        &[
                            &PredefinedMenuItem::undo(app, None)?,
                            // Redo omitted — Cmd+Y is used for Toggle Auto-yes
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::cut(app, None)?,
                            &PredefinedMenuItem::copy(app, None)?,
                            &PredefinedMenuItem::paste(app, None)?,
                            &PredefinedMenuItem::select_all(app, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "View",
                        true,
                        &[
                            &PredefinedMenuItem::fullscreen(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &debug_item,
                            &pty_debug_item,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Window",
                        true,
                        &[
                            &PredefinedMenuItem::minimize(app, None)?,
                            &PredefinedMenuItem::maximize(app, None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::close_window(app, None)?,
                        ],
                    )?,
                    &Submenu::with_items(app, "Help", true, &[])?,
                ],
            )?;

            app.set_menu(app_menu)?;
            {
                let state = app.state::<AppState>();
                let shortcuts = state.settings.lock().unwrap().shortcuts.clone();
                let _ = refresh_shortcut_menu(&app.handle().clone(), &shortcuts);
            }
            app.on_menu_event(|app, event| {
                log::info!("menu_event: id={:?}", event.id.as_ref());
                if event.id.as_ref() == "import_cwt" {
                    if let Some(window) = app.get_webview_window("settings") {
                        let _ = window.emit("import-cwt", ());
                    }
                } else if event.id.as_ref() == "view_debug" {
                    open_debug_window(app);
                } else if event.id.as_ref() == "view_pty_debug" {
                    open_pty_debug_window(app);
                } else if event.id.as_ref() == MENU_SHORTCUT_RENAME_ACTIVE_PANE {
                    let _ = app.emit("shortcut-action", "rename_active_pane");
                } else if event.id.as_ref() == MENU_SHORTCUT_FOCUS_AGENT_INPUT {
                    let _ = app.emit("shortcut-action", "focus_agent_input");
                } else if event.id.as_ref() == MENU_SHORTCUT_ZOOM_ACTIVE_PANE {
                    let _ = app.emit("shortcut-action", "zoom_active_pane");
                } else if event.id.as_ref() == MENU_SHORTCUT_TOGGLE_AUTO_YES {
                    let _ = app.emit("shortcut-action", "toggle_auto_yes");
                }
            });

            // Background task: refresh provider usage stats every 5 minutes
            tauri::async_runtime::spawn(async move {
                loop {
                    let zai_token = {
                        let secrets = secrets_for_usage.lock().unwrap();
                        let explicit = usage::ZAI_TOKEN_KEYS
                            .iter()
                            .map(|key| secrets.get(key).cloned())
                            .collect();
                        usage::resolve_zai_token_from_sources(explicit)
                    };
                    let usage = usage::fetch_usage_snapshot(zai_token).await;
                    let _ = refresh_tray_usage_menu(&app_for_usage, Some(&usage));
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
                        {
                            let show = app_handle
                                .state::<AppState>()
                                .settings
                                .lock()
                                .unwrap()
                                .show_in_dock;
                            if !show {
                                let _ = app_handle
                                    .set_activation_policy(tauri::ActivationPolicy::Accessory);
                            }
                        }
                    }
                });
            }

            // Desktop is always a UI-only client. The clawtab-daemon owns
            // scheduler, relay, question detection, telegram polling, watcher,
            // and shared state (job_status, auto_yes_panes, relay handle, etc.).
            // Shared-state commands proxy to the daemon via IPC; the daemon
            // pushes state-change events back over a subscription socket.
            let event_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                events::run_daemon_event_subscription(event_app_handle).await;
            });

            // Always start auto-update checker (desktop-only concern)
            updater::start_update_checker(app.handle().clone(), settings_for_updater);

            log::info!("clawtab setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
