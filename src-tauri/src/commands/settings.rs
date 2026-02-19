use tauri::State;

use crate::config::settings::AppSettings;
use crate::AppState;

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(
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

    // Regenerate all CLAUDE.md files with updated settings
    let settings_clone = settings.clone();
    drop(settings);
    let jobs = state.jobs_config.lock().unwrap().jobs.clone();
    super::jobs::ensure_agent_dir(&settings_clone, &jobs);
    super::jobs::regenerate_all_claude_mds(&settings_clone, &jobs);

    Ok(())
}
