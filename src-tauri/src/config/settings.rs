use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub default_tmux_session: String,
    pub default_work_dir: String,
    pub claude_path: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        let home = dirs::home_dir()
            .map(|h| h.display().to_string())
            .unwrap_or_default();
        Self {
            default_tmux_session: "tgs".to_string(),
            default_work_dir: format!("{}/workspace/tgs/automation", home),
            claude_path: "claude".to_string(),
        }
    }
}

impl AppSettings {
    fn file_path() -> Option<PathBuf> {
        dirs::config_dir().map(|p| p.join("cron-manager").join("settings.yaml"))
    }

    pub fn load() -> Self {
        if let Some(path) = Self::file_path() {
            if let Ok(contents) = std::fs::read_to_string(&path) {
                if let Ok(settings) = serde_yml::from_str(&contents) {
                    return settings;
                }
            }
        }
        Self::default()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::file_path().ok_or("Could not determine config directory")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config directory: {}", e))?;
        }
        let contents =
            serde_yml::to_string(self).map_err(|e| format!("Failed to serialize: {}", e))?;
        std::fs::write(&path, contents).map_err(|e| format!("Failed to write settings: {}", e))
    }
}
