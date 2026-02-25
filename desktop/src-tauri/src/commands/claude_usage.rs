use crate::claude_usage;

#[tauri::command]
pub async fn get_claude_usage() -> Result<claude_usage::UsageResponse, String> {
    claude_usage::fetch_usage().await
}
