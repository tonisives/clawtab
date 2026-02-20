use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::telegram::TelegramConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub default_tmux_session: String,
    pub default_work_dir: String,
    pub claude_path: String,
    pub preferred_editor: String,
    pub preferred_terminal: String,
    pub setup_completed: bool,
    pub telegram: Option<TelegramConfig>,
    pub secrets_backend: String,
    pub preferred_browser: String,
    pub auto_update_enabled: bool,
    /// User-specified custom paths for tools, keyed by tool name
    pub tool_paths: HashMap<String, String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        let home = dirs::home_dir()
            .map(|h| h.display().to_string())
            .unwrap_or_default();
        Self {
            default_tmux_session: "cwt".to_string(),
            default_work_dir: format!("{}/workspace/tgs/automation", home),
            claude_path: "claude".to_string(),
            preferred_editor: "nvim".to_string(),
            preferred_terminal: "auto".to_string(),
            setup_completed: false,
            telegram: None,
            secrets_backend: "both".to_string(),
            preferred_browser: "chrome".to_string(),
            auto_update_enabled: true,
            tool_paths: HashMap::new(),
        }
    }
}

impl AppSettings {
    fn file_path() -> Option<PathBuf> {
        super::config_dir().map(|p| p.join("settings.yaml"))
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
