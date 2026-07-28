use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CalendarRepeatUnit {
    Week,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CalendarRepeat {
    pub every: u32,
    pub unit: CalendarRepeatUnit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CalendarSchedule {
    pub start: String,
    pub repeat: CalendarRepeat,
}

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

/// Preserve the difference between an omitted optional update and an explicit
/// `null` that clears the stored value.
fn deserialize_optional_optional<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<CalendarSchedule>,
    pub group: String,
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmux_session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aerospace_workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kill_on_end: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_yes: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_history: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, deserialize_with = "deserialize_job_params")]
    pub params: Vec<JobParam>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
}

/// Fields that may be changed directly from a job detail view.
/// Nested options distinguish an omitted field from an explicit clear (`null`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationEvents {
    pub start: bool,
    pub working: bool,
    pub logs: bool,
    pub finish: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct JobUpdate {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_optional")]
    pub work_dir: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_optional")]
    pub tmux_session: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_optional")]
    pub aerospace_workspace: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_optional")]
    pub notify_target: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_optional")]
    pub telegram_chat_id: Option<Option<i64>>,
    #[serde(default)]
    pub telegram_notify: Option<NotificationEvents>,
    #[serde(default)]
    pub kill_on_end: Option<bool>,
    #[serde(default)]
    pub auto_yes: Option<bool>,
    #[serde(default)]
    pub max_history: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_optional_optional")]
    pub agent_provider: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_optional")]
    pub agent_model: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_optional")]
    pub agent_effort: Option<Option<String>>,
}

#[cfg(test)]
mod tests {
    use super::JobUpdate;

    #[test]
    fn job_update_preserves_omitted_and_cleared_optional_fields() {
        let omitted: JobUpdate = serde_json::from_str("{}").unwrap();
        assert_eq!(omitted.tmux_session, None);

        let cleared: JobUpdate = serde_json::from_str(r#"{"tmux_session":null}"#).unwrap();
        assert_eq!(cleared.tmux_session, Some(None));

        let set: JobUpdate = serde_json::from_str(r#"{"tmux_session":"cwt"}"#).unwrap();
        assert_eq!(set.tmux_session, Some(Some("cwt".to_string())));
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_effort: Option<String>,
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
