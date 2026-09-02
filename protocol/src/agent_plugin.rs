use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentActionParameterKind {
    String,
    Boolean,
    Choice,
    Model,
    Effort,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentActionParameter {
    pub name: String,
    pub title: String,
    pub kind: AgentActionParameterKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentActionDescriptor {
    pub id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub title: String,
    pub description: String,
    pub provider: String,
    #[serde(default)]
    pub parameters: Vec<AgentActionParameter>,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentActionRunState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    NeedsUserAttention,
}

impl AgentActionRunState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::NeedsUserAttention
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentActionRun {
    pub run_id: String,
    pub pane_id: String,
    pub action_id: String,
    pub state: AgentActionRunState,
    pub progress: String,
    #[serde(default)]
    pub progress_percent: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSessionData {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_count: Option<u64>,
}

pub type AgentActionParameters = HashMap<String, String>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_action_descriptor_round_trips() {
        let descriptor = AgentActionDescriptor {
            id: "demo.configure".into(),
            plugin_id: "demo".into(),
            plugin_name: "Demo plugin".into(),
            title: "Configure".into(),
            description: "Configure the demo action".into(),
            provider: "codex".into(),
            parameters: vec![
                AgentActionParameter {
                    name: "enabled".into(),
                    title: "Enabled".into(),
                    kind: AgentActionParameterKind::Boolean,
                    description: Some("Enable the feature".into()),
                    required: true,
                    default_value: Some("true".into()),
                    placeholder: None,
                    options: Vec::new(),
                },
                AgentActionParameter {
                    name: "mode".into(),
                    title: "Mode".into(),
                    kind: AgentActionParameterKind::Choice,
                    description: None,
                    required: true,
                    default_value: Some("safe".into()),
                    placeholder: Some("Choose a mode".into()),
                    options: vec!["safe".into(), "fast".into()],
                },
            ],
            available: true,
            unavailable_reason: None,
        };

        let encoded = serde_json::to_string(&descriptor).expect("descriptor should serialize");
        let decoded: AgentActionDescriptor =
            serde_json::from_str(&encoded).expect("descriptor should deserialize");

        assert_eq!(decoded, descriptor);
        assert!(encoded.contains("\"kind\":\"boolean\""));
        assert!(encoded.contains("\"kind\":\"choice\""));
    }
}
