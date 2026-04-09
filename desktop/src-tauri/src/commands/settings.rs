use std::fs;
use std::io::Write;
use std::path::Path;

use tauri::{Emitter, Manager, State};

use crate::config::settings::AppSettings;
use crate::AppState;

const LOG_DIR: &str = "/tmp/clawtab";

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(
    app: tauri::AppHandle,
    state: State<AppState>,
    new_settings: AppSettings,
) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    // Preserve telegram config if the incoming payload has None,
    // since other panels (GeneralSettings, ToolsPanel) send the full
    // settings object that was loaded before telegram was configured.
    let telegram = settings.telegram.clone();
    *settings = new_settings;
    if settings.telegram.is_none() {
        settings.telegram = telegram;
    }
    settings.save()?;
    *state.process_overrides.lock().unwrap() = settings.process_overrides.clone();

    // Regenerate all cwt.md context files with updated settings
    let settings_clone = settings.clone();
    drop(settings);
    let jobs = state.jobs_config.lock().unwrap().jobs.clone();
    super::jobs::ensure_agent_dir(&settings_clone, &jobs);
    super::jobs::regenerate_all_cwt_contexts(&settings_clone, &jobs);
    let _ = app.emit("settings-updated", &settings_clone);

    Ok(())
}

#[tauri::command]
pub fn write_editor_log(lines: Vec<String>) -> Result<(), String> {
    let dir = Path::new(LOG_DIR);
    let _ = fs::create_dir_all(dir);
    let path = dir.join("editor.log");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open editor.log: {}", e))?;
    for line in &lines {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        writeln!(file, "{} {}", ts, line)
            .map_err(|e| format!("Failed to write editor.log: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        let _ = window.show();
        let _ = window.set_focus();
        Ok(())
    } else {
        Err("Settings window not found".to_string())
    }
}

#[tauri::command]
pub fn get_hostname() -> String {
    gethostname::gethostname()
        .to_string_lossy()
        .trim_end_matches(".local")
        .to_string()
}

#[tauri::command]
pub fn set_dock_visibility(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        let _ = app.set_activation_policy(policy);
    }
    Ok(())
}

#[tauri::command]
pub fn set_titlebar_visibility(app: tauri::AppHandle, hidden: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::TitleBarStyle;
        if let Some(window) = app.get_webview_window("settings") {
            let style = if hidden {
                TitleBarStyle::Overlay
            } else {
                TitleBarStyle::Visible
            };
            window.set_title_bar_style(style).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn open_logs_folder() -> Result<(), String> {
    let dir = Path::new(LOG_DIR);
    let _ = fs::create_dir_all(dir);
    std::process::Command::new("open")
        .arg(dir)
        .spawn()
        .map_err(|e| format!("Failed to open logs folder: {}", e))?;
    Ok(())
}
