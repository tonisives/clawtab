use crate::usage;

#[tauri::command]
pub async fn get_usage_snapshot() -> Result<usage::UsageSnapshot, String> {
    Ok(usage::fetch_usage_snapshot().await)
}
