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
            let job_yaml = path.join("job.yaml");
            if !job_yaml.exists() {
                continue;
            }
            let slug = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            match std::fs::read_to_string(&job_yaml) {
                Ok(contents) => match serde_yml::from_str::<Job>(&contents) {
                    Ok(mut job) => {
                        job.slug = slug;
                        jobs.push(job);
                    }
                    Err(e) => {
                        log::warn!("Failed to parse {}: {}", job_yaml.display(), e);
                    }
                },
                Err(e) => {
                    log::warn!("Failed to read {}: {}", job_yaml.display(), e);
                }
            }
        }

        jobs.sort_by(|a, b| a.name.cmp(&b.name));
        Self { jobs }
    }

    pub fn save_job(&self, job: &Job) -> Result<(), String> {
        let jobs_dir = Self::jobs_dir().ok_or("Could not determine config directory")?;
        let slug = if job.slug.is_empty() {
            derive_slug(&job.folder_path.as_deref().unwrap_or(&job.name), &self.jobs)
        } else {
            job.slug.clone()
        };
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
}

/// Derive a slug from a folder path or name.
/// Takes last 2 path components, lowercases, keeps [a-z0-9-], truncates to ~20 chars.
/// Appends -2, -3, etc. if duplicate.
pub fn derive_slug(input: &str, existing_jobs: &[Job]) -> String {
    let cleaned = input.replace('\\', "/");
    let parts: Vec<&str> = cleaned
        .trim_end_matches('/')
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".cwdt")
        .collect();

    let relevant = if parts.len() >= 2 {
        format!("{}-{}", parts[parts.len() - 2], parts[parts.len() - 1])
    } else if !parts.is_empty() {
        parts[parts.len() - 1].to_string()
    } else {
        "job".to_string()
    };

    let slug_base: String = relevant
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
    let mut slug_base = slug_base
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    // Truncate to ~20 chars at a dash boundary if possible
    if slug_base.len() > 20 {
        if let Some(pos) = slug_base[..20].rfind('-') {
            slug_base.truncate(pos);
        } else {
            slug_base.truncate(20);
        }
    }

    if slug_base.is_empty() {
        slug_base = "job".to_string();
    }

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
