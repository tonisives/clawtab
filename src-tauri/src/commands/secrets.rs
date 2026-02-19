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
pub fn import_gopass_secret(
    state: State<AppState>,
    gopass_path: String,
) -> Result<String, String> {
    let mut secrets = state.secrets.lock().unwrap();
    secrets.import_gopass(&gopass_path)
}

#[tauri::command]
pub fn remove_gopass_secret(state: State<AppState>, key: String) {
    let mut secrets = state.secrets.lock().unwrap();
    secrets.remove_gopass(&key);
}
