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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TelegramLogMode {
    Off,
    OnPrompt,
    Always,
}

impl Default for TelegramLogMode {
    fn default() -> Self {
        Self::OnPrompt
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NotifyTarget {
    None,
    Telegram,
    App,
}

impl Default for NotifyTarget {
    fn default() -> Self {
        Self::None
    }
}

/// Per-job notification flags controlling what gets sent to Telegram.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TelegramNotify {
    #[serde(default = "bool_true")]
    pub start: bool,
    #[serde(default = "bool_true")]
    pub working: bool,
    #[serde(default = "bool_true")]
    pub logs: bool,
    #[serde(default = "bool_true")]
    pub finish: bool,
}

fn bool_true() -> bool {
    true
}

impl Default for TelegramNotify {
    fn default() -> Self {
        Self {
            start: true,
            working: true,
            logs: true,
            finish: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum JobStatus {
    Idle,
    Running {
        run_id: String,
        started_at: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pane_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tmux_session: Option<String>,
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
    #[serde(default)]
    pub telegram_log_mode: TelegramLogMode,
    #[serde(default)]
    pub telegram_notify: TelegramNotify,
    #[serde(default)]
    pub notify_target: NotifyTarget,
    #[serde(default = "default_group")]
    pub group: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub skill_paths: Vec<String>,
    #[serde(default)]
    pub params: Vec<String>,
    #[serde(default = "default_true")]
    pub kill_on_end: bool,
    #[serde(default)]
    pub auto_yes: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
}

fn default_true() -> bool {
    true
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

    pub fn jobs_dir_public() -> Option<PathBuf> {
        Self::jobs_dir()
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
                    // Migration: existing jobs with telegram_chat_id but no explicit
                    // notify_target should default to Telegram to preserve behavior
                    if job.telegram_chat_id.is_some() && job.notify_target == NotifyTarget::None {
                        job.notify_target = NotifyTarget::Telegram;
                    }
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
        if job_to_save.added_at.is_none() {
            job_to_save.added_at = Some(chrono::Utc::now().to_rfc3339());
        }

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

            // Migrate job.md to central location if applicable
            // (handled by migrate_job_md_to_central at startup)
        }
    }
}

/// Migrate job.md files from `.cwt/{job_name}/job.md` to the central config location
/// `~/.config/clawtab/jobs/{slug}/job.md`, and update `folder_path` from `.cwt` dir
/// to project root.
pub fn migrate_job_md_to_central(jobs: &mut [Job]) {
    let jobs_dir = match JobsConfig::jobs_dir() {
        Some(d) => d,
        None => return,
    };

    for job in jobs.iter_mut() {
        if job.job_type != JobType::Folder {
            continue;
        }
        let folder_path = match job.folder_path.as_ref() {
            Some(fp) => fp.clone(),
            None => continue,
        };

        let fp_path = std::path::Path::new(&folder_path);
        let job_name = job.job_name.as_deref().unwrap_or("default");

        // Check if folder_path still ends in .cwt (old format)
        let is_old_format = fp_path.file_name().map(|n| n == ".cwt").unwrap_or(false);

        if is_old_format {
            // Old path: {folder_path}/{job_name}/job.md (where folder_path was .cwt dir)
            let old_job_md = fp_path.join(job_name).join("job.md");
            let central_dir = jobs_dir.join(&job.slug);
            let central_job_md = central_dir.join("job.md");

            // Copy job.md to central location if old exists and central doesn't
            if old_job_md.exists() && !central_job_md.exists() {
                let _ = std::fs::create_dir_all(&central_dir);
                if let Err(e) = std::fs::copy(&old_job_md, &central_job_md) {
                    log::warn!("Failed to copy job.md to central for '{}': {}", job.slug, e);
                } else {
                    log::info!("Migrated job.md to central for '{}'", job.slug);
                }
            }

            // Update folder_path: strip /.cwt suffix to make it project root
            if let Some(project_root) = fp_path.parent() {
                let new_fp = project_root.to_string_lossy().to_string();
                job.folder_path = Some(new_fp);
                // Save the updated job
                let job_dir = jobs_dir.join(&job.slug);
                let _ = std::fs::create_dir_all(&job_dir);
                if let Ok(yaml) = serde_yml::to_string(&job) {
                    let _ = std::fs::write(job_dir.join("job.yaml"), yaml);
                }
            }
        } else {
            // folder_path is already project root - just check if job.md needs migration
            // from .cwt subdir to central
            let cwt_dir = fp_path.join(".cwt");
            let old_job_md = cwt_dir.join(job_name).join("job.md");
            let central_dir = jobs_dir.join(&job.slug);
            let central_job_md = central_dir.join("job.md");

            if old_job_md.exists() && !central_job_md.exists() {
                let _ = std::fs::create_dir_all(&central_dir);
                if let Err(e) = std::fs::copy(&old_job_md, &central_job_md) {
                    log::warn!("Failed to copy job.md to central for '{}': {}", job.slug, e);
                } else {
                    log::info!("Migrated job.md to central for '{}'", job.slug);
                }
            }
        }
    }
}

/// Return the path to a job's job.md in the central config location.
pub fn central_job_md_path(slug: &str) -> Option<std::path::PathBuf> {
    JobsConfig::jobs_dir().map(|d| d.join(slug).join("job.md"))
}

/// Return the path to a job's auto-generated context.md in central config.
pub fn central_job_context_path(slug: &str) -> Option<std::path::PathBuf> {
    JobsConfig::jobs_dir().map(|d| d.join(slug).join("context.md"))
}

/// Return the path to a project's shared context.md in central config.
/// Extracts the project part from a slug like "myapp/deploy" -> "myapp".
pub fn central_project_context_path(slug: &str) -> Option<std::path::PathBuf> {
    let project = slug.split('/').next().unwrap_or(slug);
    JobsConfig::jobs_dir().map(|d| d.join(project).join("context.md"))
}

/// Migrate .cwt/ directories to central config.
/// Copies user scripts and context files from {folder_path}/.cwt/ to ~/.config/clawtab/jobs/,
/// then removes the .cwt/ directory.
pub fn migrate_cwt_to_central(jobs: &[Job]) {
    let jobs_dir = match JobsConfig::jobs_dir() {
        Some(d) => d,
        None => return,
    };

    // Collect unique folder_paths from folder jobs
    let mut seen_projects: std::collections::HashSet<String> = std::collections::HashSet::new();

    for job in jobs.iter().filter(|j| j.job_type == JobType::Folder) {
        let folder_path = match job.folder_path.as_ref() {
            Some(fp) => fp.clone(),
            None => continue,
        };

        let project_root = std::path::Path::new(&folder_path);
        let cwt_dir = project_root.join(".cwt");
        if !cwt_dir.is_dir() {
            continue;
        }

        let job_name = job.job_name.as_deref().unwrap_or("default");
        let project_slug = job.slug.split('/').next().unwrap_or(&job.slug);
        let central_project_dir = jobs_dir.join(project_slug);
        let central_job_dir = jobs_dir.join(&job.slug);

        // Migrate per-job files from .cwt/{job_name}/
        let cwt_job_dir = cwt_dir.join(job_name);
        if cwt_job_dir.is_dir() {
            let _ = std::fs::create_dir_all(&central_job_dir);
            if let Ok(entries) = std::fs::read_dir(&cwt_job_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    // Skip auto-generated cwt.md and already-migrated job.md
                    if name == "cwt.md" || name == "job.md" {
                        continue;
                    }
                    let dest = central_job_dir.join(&name);
                    if !dest.exists() {
                        if let Err(e) = std::fs::copy(&path, &dest) {
                            log::warn!("Failed to migrate {} to central: {}", path.display(), e);
                        } else {
                            log::info!("Migrated {} to {}", path.display(), dest.display());
                        }
                    }
                }
            }
        }

        // Migrate project-level files (only once per project)
        if seen_projects.insert(folder_path.clone()) {
            let _ = std::fs::create_dir_all(&central_project_dir);
            if let Ok(entries) = std::fs::read_dir(&cwt_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    // Migrate shared cwt.md as context.md
                    if name == "cwt.md" {
                        let dest = central_project_dir.join("context.md");
                        if !dest.exists() {
                            let _ = std::fs::copy(&path, &dest);
                            log::info!("Migrated shared context {} to {}", path.display(), dest.display());
                        }
                        continue;
                    }
                    // Migrate scripts and other files
                    let dest = central_project_dir.join(&name);
                    if !dest.exists() {
                        let _ = std::fs::copy(&path, &dest);
                        log::info!("Migrated {} to {}", path.display(), dest.display());
                    }
                }
            }

            // Remove the .cwt/ directory
            if let Err(e) = std::fs::remove_dir_all(&cwt_dir) {
                log::warn!("Failed to remove .cwt/ at {}: {}", cwt_dir.display(), e);
            } else {
                log::info!("Removed .cwt/ directory at {}", cwt_dir.display());
            }
        }
    }
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
