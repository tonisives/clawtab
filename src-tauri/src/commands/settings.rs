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
    *settings = new_settings;
    settings.save()
}
