use tauri::State;

use crate::tools;
use crate::AppState;

#[tauri::command]
pub async fn detect_tools(state: State<'_, AppState>) -> Result<Vec<tools::ToolInfo>, String> {
    let custom_paths = {
        let s = state.settings.lock().unwrap();
        s.tool_paths.clone()
    };
    tokio::task::spawn_blocking(move || tools::detect_tools(&custom_paths))
        .await
        .map_err(|e| format!("Detection failed: {}", e))
}

#[tauri::command]
pub async fn set_tool_path(
    state: State<'_, AppState>,
    tool_name: String,
    path: String,
) -> Result<(), String> {
    let mut s = state.settings.lock().unwrap();
    if path.is_empty() {
        s.tool_paths.remove(&tool_name);
    } else {
        s.tool_paths.insert(tool_name, path);
    }
    s.save()
}

#[tauri::command]
pub async fn install_tool(formula: String) -> Result<String, String> {
    let args: Vec<&str> = std::iter::once("install")
        .chain(formula.split_whitespace())
        .collect();

    let output = tokio::process::Command::new("brew")
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("Failed to run brew: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(format!("{}{}", stdout, stderr))
    } else {
        Err(format!("{}{}", stdout, stderr))
    }
}
