pub mod jobs;
pub mod protected_panes;
pub mod settings;

use std::path::PathBuf;

/// Shared config directory: ~/.config/clawtab/
pub fn config_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".config").join("clawtab"))
}
