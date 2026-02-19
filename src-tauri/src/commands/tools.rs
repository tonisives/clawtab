use crate::tools;

#[tauri::command]
pub async fn detect_tools() -> Vec<tools::ToolInfo> {
    tokio::task::spawn_blocking(tools::detect_tools)
        .await
        .unwrap_or_default()
}
