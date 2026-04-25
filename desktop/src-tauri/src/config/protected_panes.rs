use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ProtectedPanes {
    #[serde(default)]
    pub protected_pane_ids: Vec<String>,
}

fn file_path() -> Option<PathBuf> {
    super::config_dir().map(|p| p.join("protected_panes.json"))
}

pub fn load_set() -> HashSet<String> {
    let Some(path) = file_path() else { return HashSet::new() };
    let contents = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            log::debug!("protected_panes::load_set: read {} failed: {}", path.display(), e);
            return HashSet::new();
        }
    };
    match serde_json::from_str::<ProtectedPanes>(&contents) {
        Ok(p) => p.protected_pane_ids.into_iter().collect(),
        Err(e) => {
            log::debug!("protected_panes::load_set: parse {} failed: {}", path.display(), e);
            HashSet::new()
        }
    }
}

pub fn save(ids: &[String]) -> Result<(), String> {
    let path = file_path().ok_or("Could not determine config directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    let payload = ProtectedPanes {
        protected_pane_ids: ids.to_vec(),
    };
    let contents = serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents)
        .map_err(|e| format!("Failed to write {}: {}", tmp.display(), e))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("Failed to rename {} -> {}: {}", tmp.display(), path.display(), e))
}
