use crate::tools;

#[tauri::command]
pub async fn detect_tools() -> Vec<tools::ToolInfo> {
    tokio::task::spawn_blocking(tools::detect_tools)
        .await
        .unwrap_or_default()
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
