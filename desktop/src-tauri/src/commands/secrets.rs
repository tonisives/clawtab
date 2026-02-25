use tauri::State;

use crate::secrets::SecretEntry;
use crate::AppState;

#[tauri::command]
pub fn list_secrets(state: State<AppState>) -> Vec<SecretEntry> {
    let secrets = state.secrets.lock().unwrap();
    secrets.list_entries()
}

#[tauri::command]
pub fn set_secret(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    let mut secrets = state.secrets.lock().unwrap();
    secrets.set(&key, &value)
}

#[tauri::command]
pub fn delete_secret(state: State<AppState>, key: String) -> Result<(), String> {
    let mut secrets = state.secrets.lock().unwrap();
    secrets.delete(&key)
}

#[tauri::command]
pub fn gopass_available(state: State<AppState>) -> bool {
    let secrets = state.secrets.lock().unwrap();
    secrets.gopass_available()
}

#[tauri::command]
pub fn list_gopass_store(state: State<AppState>) -> Result<Vec<String>, String> {
    let secrets = state.secrets.lock().unwrap();
    secrets.list_gopass_store()
}

#[tauri::command]
pub fn fetch_gopass_value(gopass_path: String) -> Result<String, String> {
    crate::secrets::gopass::GopassBackend::fetch_value(&gopass_path)
}
