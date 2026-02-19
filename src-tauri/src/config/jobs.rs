use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum JobType {
    Binary,
    Claude,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum JobStatus {
    Idle,
    Running {
        run_id: String,
        started_at: String,
    },
    Success {
        last_run: String,
    },
    Failed {
        last_run: String,
        exit_code: i32,
    },
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub name: String,
    pub job_type: JobType,
    pub enabled: bool,
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cron: String,
    #[serde(default)]
    pub secret_keys: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub work_dir: Option<String>,
    pub tmux_session: Option<String>,
    pub aerospace_workspace: Option<String>,
    pub folder_path: Option<String>,
    pub job_name: Option<String>,
    pub telegram_chat_id: Option<i64>,
    #[serde(default = "default_group")]
    pub group: String,
    #[serde(default)]
    pub slug: String,
}

fn default_group() -> String {
    "default".to_string()
}

#[derive(Debug, Clone, Default)]
pub struct JobsConfig {
    pub jobs: Vec<Job>,
}

impl JobsConfig {
    fn jobs_dir() -> Option<PathBuf> {
        super::config_dir().map(|p| p.join("jobs"))
    }

    fn legacy_file_path() -> Option<PathBuf> {
        super::config_dir().map(|p| p.join("jobs.yaml"))
    }

    pub fn load() -> Self {
        // Migrate legacy jobs.yaml if it exists
        Self::migrate_legacy();
        // Migrate flat slug dirs to nested project/job-name dirs
        Self::migrate_flat_slugs();

        let jobs_dir = match Self::jobs_dir() {
            Some(d) => d,
            None => return Self::default(),
        };

        if !jobs_dir.is_dir() {
            return Self::default();
        }

        let mut jobs = Vec::new();
        let entries = match std::fs::read_dir(&jobs_dir) {
            Ok(e) => e,
            Err(_) => return Self::default(),
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let project_name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // Check if this dir itself has a job.yaml (old flat format -- should be migrated)
            let flat_yaml = path.join("job.yaml");
            if flat_yaml.exists() {
                if let Some(job) = Self::load_job_yaml(&flat_yaml, &project_name) {
                    jobs.push(job);
                }
                continue;
            }

            // Recurse one level: look for {project}/{job-name}/job.yaml
            let sub_entries = match std::fs::read_dir(&path) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for sub_entry in sub_entries.flatten() {
                let sub_path = sub_entry.path();
                if !sub_path.is_dir() {
                    continue;
                }
                let job_yaml = sub_path.join("job.yaml");
                if !job_yaml.exists() {
                    continue;
                }
                let job_name = sub_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let slug = format!("{}/{}", project_name, job_name);
                if let Some(mut job) = Self::load_job_yaml(&job_yaml, &slug) {
                    if job.job_name.is_none() {
                        job.job_name = Some(job_name);
                    }
                    jobs.push(job);
                }
            }
        }

        jobs.sort_by(|a, b| a.name.cmp(&b.name));
        Self { jobs }
    }

    fn load_job_yaml(path: &std::path::Path, slug: &str) -> Option<Job> {
        match std::fs::read_to_string(path) {
            Ok(contents) => match serde_yml::from_str::<Job>(&contents) {
                Ok(mut job) => {
                    job.slug = slug.to_string();
                    Some(job)
                }
                Err(e) => {
                    log::warn!("Failed to parse {}: {}", path.display(), e);
                    None
                }
            },
            Err(e) => {
                log::warn!("Failed to read {}: {}", path.display(), e);
                None
            }
        }
    }

    pub fn save_job(&self, job: &Job) -> Result<(), String> {
        let jobs_dir = Self::jobs_dir().ok_or("Could not determine config directory")?;
        let slug = if job.slug.is_empty() {
            derive_slug(
                &job.folder_path.as_deref().unwrap_or(&job.name),
                job.job_name.as_deref(),
                &self.jobs,
            )
        } else {
            job.slug.clone()
        };
        // Slug is now "project/job-name", so join directly creates nested dirs
        let job_dir = jobs_dir.join(&slug);
        std::fs::create_dir_all(&job_dir)
            .map_err(|e| format!("Failed to create job directory: {}", e))?;

        let mut job_to_save = job.clone();
        job_to_save.slug = slug;

        let contents = serde_yml::to_string(&job_to_save)
            .map_err(|e| format!("Failed to serialize job: {}", e))?;
        std::fs::write(job_dir.join("job.yaml"), contents)
            .map_err(|e| format!("Failed to write job.yaml: {}", e))
    }

    pub fn delete_job(&self, slug: &str) -> Result<(), String> {
        let jobs_dir = Self::jobs_dir().ok_or("Could not determine config directory")?;
        let job_dir = jobs_dir.join(slug);
        if job_dir.is_dir() {
            std::fs::remove_dir_all(&job_dir)
                .map_err(|e| format!("Failed to remove job directory: {}", e))?;
        }
        // Clean up empty parent (project) directory if it's now empty
        if let Some(parent) = job_dir.parent() {
            if parent != jobs_dir && parent.is_dir() {
                let is_empty = parent
                    .read_dir()
                    .map(|mut d| d.next().is_none())
                    .unwrap_or(false);
                if is_empty {
                    let _ = std::fs::remove_dir(parent);
                }
            }
        }
        Ok(())
    }

    fn migrate_legacy() {
        let legacy_path = match Self::legacy_file_path() {
            Some(p) => p,
            None => return,
        };

        if !legacy_path.exists() {
            return;
        }

        log::info!("Migrating legacy jobs.yaml to folder-based storage");

        let contents = match std::fs::read_to_string(&legacy_path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("Failed to read legacy jobs.yaml: {}", e);
                return;
            }
        };

        #[derive(Deserialize)]
        struct LegacyConfig {
            #[serde(default)]
            jobs: Vec<Job>,
        }

        let legacy: LegacyConfig = match serde_yml::from_str(&contents) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("Failed to parse legacy jobs.yaml: {}", e);
                return;
            }
        };

        let jobs_dir = match Self::jobs_dir() {
            Some(d) => d,
            None => return,
        };

        let mut existing_slugs: Vec<String> = Vec::new();
        // Build a temporary jobs list for slug dedup
        let mut temp_jobs: Vec<Job> = Vec::new();

        for mut job in legacy.jobs {
            let slug = derive_slug(
                &job.folder_path.as_deref().unwrap_or(&job.name),
                job.job_name.as_deref(),
                &temp_jobs,
            );
            job.slug = slug.clone();
            if job.group.is_empty() {
                job.group = "default".to_string();
            }

            let job_dir = jobs_dir.join(&slug);
            if let Err(e) = std::fs::create_dir_all(&job_dir) {
                log::warn!("Failed to create job dir {}: {}", slug, e);
                continue;
            }
            match serde_yml::to_string(&job) {
                Ok(yaml) => {
                    if let Err(e) = std::fs::write(job_dir.join("job.yaml"), yaml) {
                        log::warn!("Failed to write job.yaml for {}: {}", slug, e);
                    }
                }
                Err(e) => {
                    log::warn!("Failed to serialize job {}: {}", slug, e);
                }
            }

            existing_slugs.push(slug);
            temp_jobs.push(job);
        }

        // Rename old file as backup
        let backup_path = legacy_path.with_extension("yaml.bak");
        if let Err(e) = std::fs::rename(&legacy_path, &backup_path) {
            log::warn!("Failed to rename jobs.yaml to backup: {}", e);
        } else {
            log::info!("Legacy jobs.yaml migrated and backed up to jobs.yaml.bak");
        }
    }

    /// Migrate flat slug dirs (jobs/{flat-slug}/job.yaml) to nested (jobs/{project}/{job-name}/job.yaml).
    /// Old format: jobs/myapp-deploy/job.yaml
    /// New format: jobs/myapp/deploy/job.yaml (with job_name set)
    fn migrate_flat_slugs() {
        let jobs_dir = match Self::jobs_dir() {
            Some(d) => d,
            None => return,
        };

        if !jobs_dir.is_dir() {
            return;
        }

        let entries = match std::fs::read_dir(&jobs_dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let job_yaml = path.join("job.yaml");
            if !job_yaml.exists() {
                continue;
            }

            // This is a flat slug dir -- read the job to check if it needs migration
            let contents = match std::fs::read_to_string(&job_yaml) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let job: Job = match serde_yml::from_str(&contents) {
                Ok(j) => j,
                Err(_) => continue,
            };

            // Already has a job_name -- skip (or it's already nested)
            if job.job_name.is_some() {
                // If it has a job_name but is still flat, move it
                // Actually, check if slug contains '/' -- if so, it's already nested
                let dir_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                if dir_name.contains('/') {
                    continue;
                }
            }

            // Derive project slug from folder_path
            let project_slug = if let Some(ref fp) = job.folder_path {
                let cleaned = fp.replace('\\', "/");
                let parts: Vec<&str> = cleaned
                    .trim_end_matches('/')
                    .split('/')
                    .filter(|s| !s.is_empty() && *s != ".cwt")
                    .collect();
                if !parts.is_empty() {
                    slugify(parts[parts.len() - 1], 20)
                } else {
                    slugify(&job.name, 20)
                }
            } else {
                slugify(&job.name, 20)
            };

            let job_name = job.job_name.clone().unwrap_or_else(|| "default".to_string());
            let new_dir = jobs_dir.join(&project_slug).join(&job_name);

            if new_dir.exists() {
                continue;
            }

            log::info!(
                "Migrating flat slug '{}' to '{}/{}'",
                path.display(),
                project_slug,
                job_name
            );

            if let Err(e) = std::fs::create_dir_all(&new_dir) {
                log::warn!("Failed to create migration dir: {}", e);
                continue;
            }

            // Write updated job.yaml with job_name
            let mut migrated_job = job;
            if migrated_job.job_name.is_none() {
                migrated_job.job_name = Some("default".to_string());
            }
            migrated_job.slug = format!("{}/{}", project_slug, job_name);

            match serde_yml::to_string(&migrated_job) {
                Ok(yaml) => {
                    if let Err(e) = std::fs::write(new_dir.join("job.yaml"), yaml) {
                        log::warn!("Failed to write migrated job.yaml: {}", e);
                        continue;
                    }
                }
                Err(e) => {
                    log::warn!("Failed to serialize migrated job: {}", e);
                    continue;
                }
            }

            // Move logs directory if it exists
            let old_logs = path.join("logs");
            if old_logs.is_dir() {
                let new_logs = new_dir.join("logs");
                if let Err(e) = std::fs::rename(&old_logs, &new_logs) {
                    log::warn!("Failed to move logs: {}", e);
                }
            }

            // Remove old flat dir
            if let Err(e) = std::fs::remove_dir_all(&path) {
                log::warn!("Failed to remove old flat slug dir: {}", e);
            }

            // Also migrate .cwt/job.md -> .cwt/default/job.md if needed
            if let Some(ref fp) = migrated_job.folder_path {
                migrate_cwt_root(std::path::Path::new(fp));
            }
        }
    }
}

/// Migrate a legacy .cwt/ folder: if job.md exists at root, move it to default/job.md.
pub fn migrate_cwt_root(cwt_path: &std::path::Path) {
    let root_job_md = cwt_path.join("job.md");
    if !root_job_md.exists() {
        return;
    }

    // Check if there's already a subfolder with a job.md (not a legacy layout)
    if let Ok(entries) = std::fs::read_dir(cwt_path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.join("job.md").exists() {
                // Already has subfolder jobs, root job.md is the shared context or leftover
                return;
            }
        }
    }

    let default_dir = cwt_path.join("default");
    if let Err(e) = std::fs::create_dir_all(&default_dir) {
        log::warn!("Failed to create default job dir: {}", e);
        return;
    }

    let dest = default_dir.join("job.md");
    if let Err(e) = std::fs::rename(&root_job_md, &dest) {
        log::warn!("Failed to migrate job.md to default/: {}", e);
        return;
    }

    // Also move cwt.md (auto-generated context) if it exists
    let root_cwt_md = cwt_path.join("cwt.md");
    if root_cwt_md.exists() {
        let dest_cwt = default_dir.join("cwt.md");
        let _ = std::fs::rename(&root_cwt_md, &dest_cwt);
    }

    log::info!("Migrated .cwt/job.md to .cwt/default/job.md at {}", cwt_path.display());
}

/// Derive a slug from a folder path or name + optional job_name.
/// Returns "project-slug/job-name" for multi-job, or "project-slug/default" when no job_name.
/// Appends -2, -3, etc. if duplicate.
pub fn derive_slug(input: &str, job_name: Option<&str>, existing_jobs: &[Job]) -> String {
    let cleaned = input.replace('\\', "/");
    let parts: Vec<&str> = cleaned
        .trim_end_matches('/')
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".cwt")
        .collect();

    // Derive the project part from the last meaningful path component
    let project_part = if !parts.is_empty() {
        parts[parts.len() - 1].to_string()
    } else {
        "job".to_string()
    };

    let project_slug = slugify(&project_part, 20);
    let job_part = job_name.unwrap_or("default");
    let job_slug = slugify(job_part, 20);

    let slug_base = format!("{}/{}", project_slug, job_slug);

    let existing_slugs: Vec<&str> = existing_jobs.iter().map(|j| j.slug.as_str()).collect();

    if !existing_slugs.contains(&slug_base.as_str()) {
        return slug_base;
    }

    let mut counter = 2;
    loop {
        let candidate = format!("{}-{}", slug_base, counter);
        if !existing_slugs.contains(&candidate.as_str()) {
            return candidate;
        }
        counter += 1;
    }
}

/// Slugify a string: lowercase, keep [a-z0-9-], collapse dashes, truncate.
fn slugify(input: &str, max_len: usize) -> String {
    let mut slug: String = input
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    // Collapse consecutive dashes
    slug = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    if slug.len() > max_len {
        if let Some(pos) = slug[..max_len].rfind('-') {
            slug.truncate(pos);
        } else {
            slug.truncate(max_len);
        }
    }

    if slug.is_empty() {
        slug = "job".to_string();
    }

    slug
}
