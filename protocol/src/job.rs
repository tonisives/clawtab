use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JobParam {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

impl JobParam {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into(), value: None }
    }
}

pub fn deserialize_job_params<'de, D>(deserializer: D) -> Result<Vec<JobParam>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Either {
        Name(String),
        Full(JobParam),
    }
    let raw: Vec<Either> = Vec::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .map(|e| match e {
            Either::Name(name) => JobParam { name, value: None },
            Either::Full(p) => p,
        })
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionOption {
    pub number: String,
    pub label: String,
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub col: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeQuestion {
    pub pane_id: String,
    pub cwd: String,
    pub tmux_session: String,
    pub window_name: String,
    pub question_id: String,
    pub context_lines: String,
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub input_mode: String,
    #[serde(default)]
    pub button_row: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_job: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteJob {
    pub name: String,
    pub job_type: String,
    pub enabled: bool,
    pub cron: String,
    pub group: String,
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, deserialize_with = "deserialize_job_params")]
    pub params: Vec<JobParam>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
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
pub struct DetectedProcess {
    pub pane_id: String,
    pub cwd: String,
    pub version: String,
    pub provider: String,
    pub can_fork_session: bool,
    pub can_send_skills: bool,
    pub can_inject_secrets: bool,
    pub tmux_session: String,
    pub window_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_job: Option<String>,
    pub log_lines: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentActivity {
    pub pane_id: String,
    pub working: bool,
    pub asking: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    #[serde(alias = "job_name")]
    pub job_id: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub trigger: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunDetail {
    pub id: String,
    #[serde(alias = "job_name")]
    pub job_id: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub trigger: String,
    pub stdout: String,
    pub stderr: String,
}
