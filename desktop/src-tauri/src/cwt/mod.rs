use std::path::{Path, PathBuf};

use serde::Serialize;

/// A `.cwt` folder job. Represents a single job within a project's `.cwt/` directory.
/// Scripts live at `{project_root}/.cwt/` and `{project_root}/.cwt/{job_name}/`.
#[derive(Debug, Clone, Serialize)]
pub struct CwtFolder {
    /// The project root directory
    pub path: PathBuf,
    /// The job subfolder name (e.g., "deploy", "lint", "default")
    pub job_name: String,
    pub scripts: Vec<String>,
}

impl CwtFolder {
    /// Create from a project root path + job name.
    /// Looks for scripts in `{project_root}/.cwt/` and `{project_root}/.cwt/{job_name}/`.
    pub fn from_path_with_job(project_root: &Path, job_name: &str) -> Result<Self, String> {
        if !project_root.is_dir() {
            return Err(format!("Not a directory: {}", project_root.display()));
        }

        let cwt_dir = project_root.join(".cwt");
        let job_dir = cwt_dir.join(job_name);

        // Collect scripts from both the .cwt/ root and the job subfolder
        let mut scripts = Vec::new();
        if cwt_dir.is_dir() {
            scripts = list_scripts(&cwt_dir);
        }
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
            path: project_root.to_path_buf(),
            job_name: job_name.to_string(),
            scripts,
        })
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
