pub mod jobs;
pub mod settings;

use std::path::PathBuf;

/// Shared config directory: ~/.config/clawdtab/
pub fn config_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".config").join("clawdtab"))
}
