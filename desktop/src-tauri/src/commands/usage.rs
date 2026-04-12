use tauri::State;

use crate::usage;
use crate::AppState;

#[tauri::command]
pub async fn get_usage_snapshot(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<usage::UsageSnapshot, String> {
    let zai_token = {
        let secrets = state.secrets.lock().unwrap();
        let explicit = usage::ZAI_TOKEN_KEYS
            .iter()
            .map(|key| secrets.get(key).cloned())
            .collect();
        usage::resolve_zai_token_from_sources(explicit)
    };
    let snapshot = usage::fetch_usage_snapshot(zai_token).await;
    let _ = crate::refresh_tray_usage_menu(&app, Some(&snapshot));
    Ok(snapshot)
}
