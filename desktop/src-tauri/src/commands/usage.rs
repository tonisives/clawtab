use tauri::State;

use crate::usage;
use crate::AppState;

#[tauri::command]
pub async fn get_usage_snapshot(
    state: State<'_, AppState>,
) -> Result<usage::UsageSnapshot, String> {
    let zai_token = {
        let secrets = state.secrets.lock().unwrap();
        let explicit = secrets
            .get("Z_AI_API_KEY")
            .cloned()
            .or_else(|| std::env::var("Z_AI_API_KEY").ok());
        usage::resolve_zai_token_from_sources(explicit)
    };
    Ok(usage::fetch_usage_snapshot(zai_token).await)
}
