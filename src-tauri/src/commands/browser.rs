use crate::browser;

#[tauri::command]
pub fn launch_browser_auth(job_name: String, url: String) -> Result<(), String> {
    browser::launch_auth_session(&url, &job_name)
}

#[tauri::command]
pub fn check_browser_session(job_name: String) -> bool {
    browser::has_session(&job_name)
}

#[tauri::command]
pub fn clear_browser_session(job_name: String) -> Result<(), String> {
    browser::clear_session(&job_name)
}
