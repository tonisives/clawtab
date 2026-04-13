use std::collections::HashMap;
use tauri::State;

use crate::agent_session::ProcessProvider;
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
pub async fn detect_agent_providers() -> Result<Vec<ProcessProvider>, String> {
    tokio::task::spawn_blocking(move || {
        Ok::<Vec<ProcessProvider>, String>(
            [
                ProcessProvider::Claude,
                ProcessProvider::Codex,
                ProcessProvider::Opencode,
                ProcessProvider::Shell,
            ]
            .into_iter()
            .filter(|provider| {
                matches!(provider, ProcessProvider::Shell)
                    || tools::which(provider.binary_name()).is_some()
            })
            .collect(),
        )
    })
    .await
    .map_err(|e| format!("Detection failed: {}", e))?
}

/// Returns per-provider model options: builtin models merged with user-configured custom models.
/// Each value is a list of (model_id, display_name) pairs.
#[tauri::command]
pub fn get_model_options(
    state: State<'_, AppState>,
) -> HashMap<String, Vec<(String, String)>> {
    let enabled_models = {
        let s = state.settings.lock().unwrap();
        s.enabled_models.clone()
    };
    let providers = [
        ProcessProvider::Claude,
        ProcessProvider::Codex,
        ProcessProvider::Opencode,
        ProcessProvider::Shell,
    ];
    let mut result = HashMap::new();
    for provider in providers {
        let key = provider.as_str().to_string();
        let mut models: Vec<(String, String)> = provider
            .builtin_models()
            .iter()
            .map(|(id, name)| (id.to_string(), name.to_string()))
            .collect();
        // Append user-configured custom models
        if let Some(custom) = enabled_models.get(&key) {
            for model_id in custom {
                if !models.iter().any(|(id, _)| id == model_id) {
                    models.push((model_id.clone(), model_id.clone()));
                }
            }
        }
        result.insert(key, models);
    }
    result
}

/// Runs `opencode models` and returns the list of available model IDs (e.g. "opencode/big-pickle").
#[tauri::command]
pub async fn detect_opencode_models() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        let output = std::process::Command::new("opencode")
            .arg("models")
            .output()
            .map_err(|e| format!("Failed to run opencode models: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("opencode models failed: {}", stderr));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let models: Vec<String> = stdout
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        Ok(models)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
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
