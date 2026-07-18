use crate::agent_hooks::{self, AgentIntegrationStatus};
use crate::agent_session::ProcessProvider;
use std::path::PathBuf;
use tauri::Manager;

#[tauri::command]
pub async fn get_agent_integrations() -> Result<Vec<AgentIntegrationStatus>, String> {
    tokio::task::spawn_blocking(agent_hooks::integration_statuses)
        .await
        .map_err(|error| format!("Integration detection failed: {}", error))
}

#[tauri::command]
pub async fn install_agent_integration(
    app: tauri::AppHandle,
    provider: ProcessProvider,
) -> Result<Vec<AgentIntegrationStatus>, String> {
    let helper = resolve_bundled_helper(&app);
    tokio::task::spawn_blocking(move || {
        agent_hooks::install_provider(provider, helper.as_deref())?;
        Ok(agent_hooks::integration_statuses())
    })
    .await
    .map_err(|error| format!("Integration setup failed: {}", error))?
}

#[tauri::command]
pub async fn remove_agent_integration(
    provider: ProcessProvider,
) -> Result<Vec<AgentIntegrationStatus>, String> {
    tokio::task::spawn_blocking(move || {
        agent_hooks::remove_provider(provider)?;
        Ok(agent_hooks::integration_statuses())
    })
    .await
    .map_err(|error| format!("Integration removal failed: {}", error))?
}

fn resolve_bundled_helper(app: &tauri::AppHandle) -> Option<PathBuf> {
    let resource_helper = app.path().resource_dir().ok().map(|directory| {
        directory
            .join("ClawTab Daemon.app")
            .join("Contents")
            .join("MacOS")
            .join("clawtab-hook")
    });
    if resource_helper.as_ref().is_some_and(|path| path.is_file()) {
        return resource_helper;
    }
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join("clawtab-hook")))
        .filter(|path| path.is_file())
}
