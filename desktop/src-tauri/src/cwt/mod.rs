use std::path::{Path, PathBuf};

use serde::Serialize;

/// Represents a folder job's context. Scripts are found in the central config directory.
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
    /// Looks for scripts in the central config directory:
    /// `~/.config/clawtab/jobs/{project-slug}/` and `~/.config/clawtab/jobs/{slug}/`.
    pub fn from_path_with_job(project_root: &Path, job_name: &str) -> Result<Self, String> {
        if !project_root.is_dir() {
            return Err(format!("Not a directory: {}", project_root.display()));
        }

        Ok(Self {
            path: project_root.to_path_buf(),
            job_name: job_name.to_string(),
            scripts: Vec::new(),
        })
    }

    /// Create from a slug, scanning central config for scripts.
    #[allow(dead_code)]
    pub fn from_slug(project_root: &Path, job_name: &str, slug: &str) -> Result<Self, String> {
        if !project_root.is_dir() {
            return Err(format!("Not a directory: {}", project_root.display()));
        }

        let jobs_dir = match crate::config::jobs::JobsConfig::jobs_dir_public() {
            Some(d) => d,
            None => {
                return Ok(Self {
                    path: project_root.to_path_buf(),
                    job_name: job_name.to_string(),
                    scripts: Vec::new(),
                })
            }
        };

        let project_slug = slug.split('/').next().unwrap_or(slug);
        let project_dir = jobs_dir.join(project_slug);
        let job_dir = jobs_dir.join(slug);

        let mut scripts = Vec::new();
        if project_dir.is_dir() {
            scripts = list_scripts(&project_dir);
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

#[allow(dead_code)]
fn list_scripts(dir: &Path) -> Vec<String> {
    let mut scripts = Vec::new();

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return scripts,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            // Skip config and context files
            if name == "job.md" || name == "job.yaml" || name == "context.md" {
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
