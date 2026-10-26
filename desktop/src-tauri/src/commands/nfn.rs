use crate::nfn::NfnCommand;
use serde_json::Value;

#[tauri::command]
pub async fn nfn_command(command: NfnCommand) -> Result<Value, String> {
    if matches!(
        command,
        NfnCommand::Platform { .. } | NfnCommand::ViewedPane { .. }
    ) {
        return Err("Platform state is supplied by the native host".into());
    }
    crate::nfn::cli::call(command).await
}

#[tauri::command]
pub async fn nfn_viewed_pane(
    window: tauri::WebviewWindow,
    pane_id: Option<String>,
) -> Result<(), String> {
    let pane_id = if window.is_focused().unwrap_or(false) {
        pane_id
    } else {
        None
    };
    let window_id = format!("{}:{}", std::process::id(), window.label());
    crate::nfn::cli::call(NfnCommand::ViewedPane { pane_id, window_id }).await?;
    Ok(())
}
