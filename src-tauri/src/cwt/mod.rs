use std::path::{Path, PathBuf};

use serde::Serialize;

/// A `.cwt` folder job. Represents a single job within a `.cwt/` directory.
/// The job lives at `{cwt_root}/{job_name}/job.md`.
#[derive(Debug, Clone, Serialize)]
pub struct CwtFolder {
    /// The .cwt/ root directory
    pub path: PathBuf,
    /// The job subfolder name (e.g., "deploy", "lint", "default")
    pub job_name: String,
    pub has_entry_point: bool,
    pub scripts: Vec<String>,
}

impl CwtFolder {
    /// Create from a .cwt root path + job name.
    /// The job directory is at `{cwt_root}/{job_name}/`.
    pub fn from_path_with_job(cwt_root: &Path, job_name: &str) -> Result<Self, String> {
        if !cwt_root.is_dir() {
            return Err(format!("Not a directory: {}", cwt_root.display()));
        }

        let job_dir = cwt_root.join(job_name);
        let entry_point = job_dir.join("job.md");
        let has_entry_point = entry_point.exists();

        // Collect scripts from both the root .cwt/ and the job subfolder
        let mut scripts = list_scripts(cwt_root);
        if job_dir.is_dir() {
            let job_scripts = list_scripts(&job_dir);
            for s in job_scripts {
                if !scripts.contains(&s) {
                    scripts.push(s);
                }
            }
        }
        scripts.sort();

        Ok(Self {
            path: cwt_root.to_path_buf(),
            job_name: job_name.to_string(),
            has_entry_point,
            scripts,
        })
    }

    /// Path to this job's entry point (job.md)
    pub fn entry_point(&self) -> PathBuf {
        self.path.join(&self.job_name).join("job.md")
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
