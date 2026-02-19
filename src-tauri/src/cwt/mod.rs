use std::path::{Path, PathBuf};

use serde::Serialize;

/// A `.cwt` folder job. Contains a `job.md` entry point, auto-generated `cwt.md` context, and optional scripts.
#[derive(Debug, Clone, Serialize)]
pub struct CwtFolder {
    pub path: PathBuf,
    pub has_entry_point: bool,
    pub scripts: Vec<String>,
}

impl CwtFolder {
    pub fn from_path(path: &Path) -> Result<Self, String> {
        if !path.is_dir() {
            return Err(format!("Not a directory: {}", path.display()));
        }

        let entry_point = path.join("job.md");
        let has_entry_point = entry_point.exists();

        let scripts = list_scripts(path);

        Ok(Self {
            path: path.to_path_buf(),
            has_entry_point,
            scripts,
        })
    }

    pub fn entry_point(&self) -> PathBuf {
        self.path.join("job.md")
    }

    /// Read the entry point content
    pub fn read_entry_point(&self) -> Result<String, String> {
        let path = self.entry_point();
        std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))
    }

}

fn list_scripts(dir: &Path) -> Vec<String> {
    let mut scripts = Vec::new();

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return scripts,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            // Skip the entry point and auto-generated context
            if name == "job.md" || name == "cwt.md" {
                continue;
            }
            // Include script-like files
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if matches!(ext, "sh" | "py" | "js" | "ts" | "rb" | "md") {
                scripts.push(name);
            }
        }
    }

    scripts.sort();
    scripts
}
