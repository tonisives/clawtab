use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::claude_session::ProcessProvider;
use crate::commands::processes::DetectedProcessOverride;
use crate::telegram::TelegramConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ShortcutSettings {
    pub prefix_key: String,
    pub next_sidebar_item: String,
    pub previous_sidebar_item: String,
    pub toggle_sidebar: String,
    pub split_pane_vertical: String,
    pub split_pane_horizontal: String,
    pub kill_pane: String,
    pub move_pane_left: String,
    pub move_pane_down: String,
    pub move_pane_up: String,
    pub move_pane_right: String,
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            prefix_key: "Ctrl+2".to_string(),
            next_sidebar_item: "Alt+Tab".to_string(),
            previous_sidebar_item: "Alt+Shift+Tab".to_string(),
            toggle_sidebar: "Meta+e".to_string(),
            split_pane_vertical: "Prefix v".to_string(),
            split_pane_horizontal: "Prefix s".to_string(),
            kill_pane: "Prefix q".to_string(),
            move_pane_left: "Ctrl+h".to_string(),
            move_pane_down: "Ctrl+j".to_string(),
            move_pane_up: "Ctrl+k".to_string(),
            move_pane_right: "Ctrl+l".to_string(),
        }
    }
}

impl ShortcutSettings {
    fn migrate_legacy_tab_navigation(&mut self) {
        if self.next_sidebar_item == "Tab" && self.previous_sidebar_item == "Shift+Tab" {
            self.next_sidebar_item = "Alt+Tab".to_string();
            self.previous_sidebar_item = "Alt+Shift+Tab".to_string();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RelaySettings {
    pub enabled: bool,
    #[serde(default)]
    pub server_url: String,
    #[serde(default)]
    pub device_token: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub default_tmux_session: String,
    pub default_work_dir: String,
    pub default_provider: ProcessProvider,
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
    /// Ordered list of job group names for display ordering
    pub group_order: Vec<String>,
    /// Ordered list of job slugs per group for manual in-group job ordering
    pub job_order: HashMap<String, Vec<String>>,
    /// Groups hidden from the main sidebar list
    pub hidden_groups: Vec<String>,
    /// Remote relay server settings
    pub relay: Option<RelaySettings>,
    /// Whether to show the app icon in the macOS Dock
    pub show_in_dock: bool,
    /// Whether to hide the native title bar (uses overlay style)
    pub hide_titlebar: bool,
    /// Per-pane detected process metadata overrides.
    pub process_overrides: HashMap<String, DetectedProcessOverride>,
    /// User-configurable desktop keyboard shortcuts.
    pub shortcuts: ShortcutSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        let home = dirs::home_dir()
            .map(|h| h.display().to_string())
            .unwrap_or_default();
        Self {
            default_tmux_session: "cwt".to_string(),
            default_work_dir: format!("{}/workspace/tgs/automation", home),
            default_provider: ProcessProvider::Claude,
            claude_path: "claude".to_string(),
            preferred_editor: "nvim".to_string(),
            preferred_terminal: "auto".to_string(),
            setup_completed: false,
            telegram: None,
            secrets_backend: "both".to_string(),
            preferred_browser: "chrome".to_string(),
            auto_update_enabled: true,
            tool_paths: HashMap::new(),
            group_order: Vec::new(),
            job_order: HashMap::new(),
            hidden_groups: Vec::new(),
            relay: None,
            show_in_dock: true,
            hide_titlebar: true,
            process_overrides: HashMap::new(),
            shortcuts: ShortcutSettings::default(),
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
                if let Ok(mut settings) = serde_yml::from_str::<Self>(&contents) {
                    settings.shortcuts.migrate_legacy_tab_navigation();
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
