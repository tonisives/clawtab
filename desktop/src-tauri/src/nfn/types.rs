use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct NfnSettings {
    pub delivery: String,
    pub placement: String,
    pub focus: String,
    pub display: String,
    pub position: Option<NfnPosition>,
    pub preview_seconds: u32,
    pub hover_expand: bool,
    pub sound: bool,
    pub menu_bar_icon: bool,
}

impl Default for NfnSettings {
    fn default() -> Self {
        Self {
            delivery: "enhanced".into(),
            placement: "notch".into(),
            focus: "follow".into(),
            display: "primary".into(),
            position: None,
            preview_seconds: 8,
            hover_expand: false,
            sound: true,
            menu_bar_icon: true,
        }
    }
}

impl NfnSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !["enhanced", "native", "both"].contains(&self.delivery.as_str())
            || !["notch", "right", "custom"].contains(&self.placement.as_str())
            || !["follow", "independent"].contains(&self.focus.as_str())
            || !(2..=120).contains(&self.preview_seconds)
            || self.display.is_empty()
            || self.position.as_ref().is_some_and(|p| {
                !p.right.is_finite() || !p.top.is_finite() || p.right < 0.0 || p.top < 0.0
            })
            || (self.placement == "custom" && self.position.is_none())
        {
            return Err("Invalid notification settings".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NfnPosition {
    pub right: f64,
    pub top: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct NfnSource {
    pub pane_id: Option<String>,
    pub session_id: Option<String>,
    pub pane_pid: Option<String>,
    pub process_started_at: Option<i64>,
    pub agent_pid: Option<String>,
    pub agent_started_at: Option<i64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub task: Option<String>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub job_id: Option<String>,
    pub run_id: Option<String>,
    pub client_tty: Option<String>,
    pub origin_pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct NfnAction {
    pub id: String,
    pub label: String,
    /// choice, focus, auto_yes, model, or plugin.
    pub kind: String,
    pub value: String,
    pub parameters: std::collections::BTreeMap<String, String>,
}

impl Default for NfnAction {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            kind: "choice".into(),
            value: String::new(),
            parameters: Default::default(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct NfnMedia {
    pub kind: String,
    pub src: String,
    pub alt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct NfnRequest {
    pub title: String,
    pub body: String,
    pub template: String,
    pub data: Value,
    pub media: Vec<NfnMedia>,
    pub actions: Vec<NfnAction>,
    pub source: NfnSource,
    /// result returns a decision to the caller; agent_message submits it to the live agent.
    pub response_destination: String,
    pub dedupe_key: Option<String>,
    pub expires_at: Option<i64>,
}

impl Default for NfnRequest {
    fn default() -> Self {
        Self {
            title: String::new(),
            body: String::new(),
            template: "question".into(),
            data: serde_json::json!({}),
            media: Vec::new(),
            actions: Vec::new(),
            source: Default::default(),
            response_destination: "result".into(),
            dedupe_key: None,
            expires_at: None,
        }
    }
}

impl NfnRequest {
    pub fn validate(&self) -> Result<(), String> {
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > 512 * 1024 {
            return Err("Notification request exceeds 512 KiB".into());
        }
        if self.title.trim().is_empty() || self.title.len() > 512 || self.body.len() > 128 * 1024 {
            return Err("Provide a title up to 512 bytes and a body up to 128 KiB".into());
        }
        super::templates::validate_id(&self.template)?;
        if !["result", "agent_message"].contains(&self.response_destination.as_str()) {
            return Err("response_destination must be result or agent_message".into());
        }
        if self.response_destination == "agent_message" && self.source.pane_id.is_none() {
            return Err("agent_message requires an agent pane".into());
        }
        let mut ids = std::collections::HashSet::new();
        for action in &self.actions {
            if action.id.is_empty()
                || action.id.len() > 128
                || action.label.is_empty()
                || action.label.len() > 256
                || !ids.insert(&action.id)
                || !["choice", "focus", "auto_yes", "model", "plugin"]
                    .contains(&action.kind.as_str())
            {
                return Err("Actions need unique IDs, labels, and a supported kind".into());
            }
        }
        if self.actions.len() > 32
            || self.media.len() > 8
            || self.dedupe_key.as_ref().is_some_and(|key| key.len() > 256)
            || serde_json::to_vec(&self.data)
                .map_err(|e| e.to_string())?
                .len()
                > 256 * 1024
        {
            return Err("Notification payload is too large".into());
        }
        for media in &self.media {
            if !["image", "video"].contains(&media.kind.as_str())
                || !(media.src.starts_with("https://")
                    || std::path::Path::new(&media.src).is_absolute())
            {
                return Err(
                    "Media requires image/video and an HTTPS URL or absolute local path".into(),
                );
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NfnResponse {
    pub request_id: String,
    pub action_id: String,
    pub text: Option<String>,
    pub status: String,
    pub responded_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NfnRecord {
    pub id: String,
    pub request: NfnRequest,
    pub status: String,
    pub response: Option<NfnResponse>,
    pub created_at: i64,
    pub updated_at: i64,
    pub read_at: Option<i64>,
    pub dismissed_at: Option<i64>,
    pub error: Option<String>,
    pub question_id: Option<String>,
}

impl NfnRecord {
    pub fn pending(&self) -> bool {
        self.status == "pending" || self.status == "delivering"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum NfnCommand {
    Send {
        request: NfnRequest,
    },
    Get {
        id: String,
    },
    List {
        #[serde(default)]
        offset: usize,
        #[serde(default)]
        pending_only: bool,
    },
    Cancel {
        id: String,
    },
    Read {
        id: String,
    },
    Dismiss {
        id: String,
    },
    DismissMany {
        ids: Vec<String>,
    },
    Respond {
        id: String,
        action_id: String,
        #[serde(default)]
        text: Option<String>,
    },
    Focus {
        id: String,
    },
    OpenJob {
        id: String,
    },
    Context {
        id: String,
    },
    AutoYes {
        id: String,
    },
    Model {
        id: String,
        model: String,
        effort: String,
    },
    Plugin {
        id: String,
        action_id: String,
        #[serde(default)]
        parameters: std::collections::HashMap<String, String>,
    },
    Templates,
    Info,
    Validate {
        yaml: String,
    },
    SaveTemplate {
        yaml: String,
    },
    Show,
    Settings,
    SaveSettings {
        patch: Value,
    },
    SetPosition {
        display: String,
        position: NfnPosition,
    },
    ViewedPane {
        pane_id: Option<String>,
        window_id: String,
    },
    Platform {
        state: PlatformState,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlatformState {
    pub available: bool,
    pub focused: Option<bool>,
    pub authorized: Option<bool>,
    pub sound_allowed: bool,
    pub frontmost_pid: Option<u32>,
    pub user_active: bool,
    pub displays: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Delivery {
    pub overlay: bool,
    pub native: bool,
    pub sound: bool,
}

pub fn delivery(
    settings: &NfnSettings,
    platform: &PlatformState,
    enabled: bool,
    viewed: bool,
) -> Delivery {
    if !enabled || viewed {
        return Delivery {
            overlay: false,
            native: false,
            sound: false,
        };
    }
    let follows = settings.focus == "follow";
    let overlay = settings.delivery != "native"
        && platform.available
        && (!follows || (platform.focused == Some(false) && platform.authorized == Some(true)));
    Delivery {
        overlay,
        native: settings.delivery == "native" || settings.delivery == "both" || !overlay,
        sound: overlay
            && settings.delivery != "both"
            && settings.sound
            && (!follows || platform.sound_allowed),
    }
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_never_plays_fallback_sound_and_preserves_focus_choice() {
        let settings = NfnSettings::default();
        let mut platform = PlatformState {
            available: true,
            authorized: Some(true),
            focused: Some(false),
            sound_allowed: true,
            ..Default::default()
        };
        assert_eq!(
            delivery(&settings, &platform, true, false),
            Delivery {
                overlay: true,
                native: false,
                sound: true
            }
        );
        for focused in [None, Some(true)] {
            platform.focused = focused;
            assert_eq!(
                delivery(&settings, &platform, true, false),
                Delivery {
                    overlay: false,
                    native: true,
                    sound: false
                }
            );
        }
        platform.focused = Some(false);
        platform.authorized = Some(false);
        assert!(!delivery(&settings, &platform, true, false).sound);
        assert!(!delivery(&settings, &platform, false, false).native);
        assert!(!delivery(&settings, &platform, true, true).native);
        let independent = NfnSettings {
            focus: "independent".into(),
            ..settings
        };
        assert!(delivery(&independent, &platform, true, false).overlay);
    }
}
