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
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct JobsConfig {
    #[serde(default)]
    pub jobs: Vec<Job>,
}

impl JobsConfig {
    fn file_path() -> Option<PathBuf> {
        dirs::config_dir().map(|p| p.join("clawdtab").join("jobs.yaml"))
    }

    pub fn load() -> Self {
        if let Some(path) = Self::file_path() {
            if let Ok(contents) = std::fs::read_to_string(&path) {
                if let Ok(config) = serde_yml::from_str(&contents) {
                    return config;
                }
            }
        }
        Self::default()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::file_path().ok_or("Could not determine config directory")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config directory: {}", e))?;
        }
        let contents =
            serde_yml::to_string(self).map_err(|e| format!("Failed to serialize: {}", e))?;
        std::fs::write(&path, contents).map_err(|e| format!("Failed to write jobs config: {}", e))
    }
}
