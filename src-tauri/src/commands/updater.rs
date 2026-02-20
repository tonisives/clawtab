use tauri::AppHandle;

use crate::updater;

#[tauri::command]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<String>, String> {
    updater::check_and_install_update(&app).await
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}
