use crate::aerospace;

#[tauri::command]
pub async fn aerospace_available() -> Result<bool, String> {
    tokio::task::spawn_blocking(aerospace::is_available)
        .await
        .map_err(|e| format!("Failed to check aerospace: {}", e))
}

#[tauri::command]
pub async fn list_aerospace_workspaces() -> Result<Vec<aerospace::AerospaceWorkspace>, String> {
    tokio::task::spawn_blocking(aerospace::list_workspaces)
        .await
        .map_err(|e| format!("Failed to list workspaces: {}", e))
}
