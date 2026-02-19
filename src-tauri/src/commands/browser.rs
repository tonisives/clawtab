use crate::browser;

#[tauri::command]
pub async fn launch_browser_auth(job_name: String, url: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || browser::launch_auth_session(&url, &job_name))
        .await
        .map_err(|e| format!("Failed to launch auth: {}", e))?
}

#[tauri::command]
pub async fn check_browser_session(job_name: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || browser::has_session(&job_name))
        .await
        .map_err(|e| format!("Failed to check session: {}", e))
}

#[tauri::command]
pub async fn clear_browser_session(job_name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || browser::clear_session(&job_name))
        .await
        .map_err(|e| format!("Failed to clear session: {}", e))?
}
