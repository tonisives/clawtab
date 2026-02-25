use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::config::settings::AppSettings;

/// Check for updates and install if available.
/// Returns the new version string if an update was installed.
pub async fn check_and_install_update(app: &AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            log::info!("Update available: v{}", version);

            let mut downloaded = 0;
            update
                .download_and_install(
                    |chunk_length, content_length| {
                        downloaded += chunk_length;
                        log::debug!("Downloaded {} of {:?}", downloaded, content_length);
                    },
                    || {
                        log::info!("Download finished, installing...");
                    },
                )
                .await
                .map_err(|e| e.to_string())?;

            log::info!("Update v{} installed, pending restart", version);
            Ok(Some(version))
        }
        Ok(None) => {
            log::info!("No update available");
            Ok(None)
        }
        Err(e) => {
            log::error!("Update check failed: {}", e);
            Err(e.to_string())
        }
    }
}

/// Start periodic update checker: 5s delay on startup, then every 24h.
pub fn start_update_checker(app: AppHandle, settings: Arc<std::sync::Mutex<AppSettings>>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;

        loop {
            let auto_update_enabled = settings
                .lock()
                .map(|s| s.auto_update_enabled)
                .unwrap_or(true);

            if auto_update_enabled {
                log::info!("Checking for updates...");
                match check_and_install_update(&app).await {
                    Ok(Some(version)) => {
                        if let Err(e) =
                            app.emit("update-installed", serde_json::json!({ "version": version }))
                        {
                            log::error!("Failed to emit update-installed event: {}", e);
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        log::error!("Update check error: {}", e);
                    }
                }
            } else {
                log::info!("Auto-update disabled, skipping check");
            }

            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });
}
