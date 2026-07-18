use crate::agent_session::{ProcessProvider, ProcessSnapshot};
use crate::events::EventSink;
use crate::ipc::AgentActivity;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const EVENT_VERSION: u8 = 1;
const MAX_EVENT_BYTES: u64 = 16 * 1024;
const OWNED_COMMAND_FRAGMENT: &str = ".config/clawtab/hooks/clawtab-hook";
const OPENCODE_SENTINEL: &str = "// clawtab-agent-hooks v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookAgentState {
    Idle,
    Working,
    Waiting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookAttention {
    Permission,
    Question,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookEventV1 {
    pub version: u8,
    pub provider: ProcessProvider,
    pub event: String,
    pub session_id: String,
    pub pane_id: Option<String>,
    pub process_id: Option<u32>,
    pub cwd: Option<String>,
    pub occurred_at_ms: u64,
    pub state: HookAgentState,
    pub attention: Option<HookAttention>,
    pub pending_tool: Option<String>,
    #[serde(default)]
    pub ended: bool,
}

impl HookEventV1 {
    pub fn from_provider_payload(
        provider: ProcessProvider,
        event: &str,
        payload: &Value,
        pane_id: Option<String>,
        process_id: Option<u32>,
    ) -> Option<Self> {
        if provider == ProcessProvider::Shell {
            return None;
        }
        let session_id = payload
            .get("session_id")
            .or_else(|| payload.get("conversationId"))
            .or_else(|| payload.get("sessionID"))
            .and_then(Value::as_str)?
            .trim();
        if session_id.is_empty() || session_id.len() > 256 {
            return None;
        }
        let notification_type = payload
            .get("notification_type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (state, attention, ended) = match event {
            "session_start" => (HookAgentState::Idle, None, false),
            "user_prompt_submit" | "post_question" | "pre_invocation" => {
                (HookAgentState::Working, None, false)
            }
            "permission_request" => (
                HookAgentState::Waiting,
                Some(HookAttention::Permission),
                false,
            ),
            "ask_user_question" => (
                HookAgentState::Waiting,
                Some(HookAttention::Question),
                false,
            ),
            "notification" if notification_type == "permission_prompt" => (
                HookAgentState::Waiting,
                Some(HookAttention::Permission),
                false,
            ),
            "notification" if notification_type == "elicitation_dialog" => (
                HookAgentState::Waiting,
                Some(HookAttention::Question),
                false,
            ),
            "notification" | "stop" => (HookAgentState::Idle, None, false),
            "session_end" => (HookAgentState::Idle, None, true),
            _ => return None,
        };
        let pending_tool = payload
            .get("tool_name")
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 80)
            .map(str::to_string);
        let cwd = payload
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 2048)
            .map(str::to_string);
        Some(Self {
            version: EVENT_VERSION,
            provider,
            event: event.to_string(),
            session_id: session_id.to_string(),
            pane_id: pane_id.filter(|value| valid_pane_id(value)),
            process_id,
            cwd,
            occurred_at_ms: now_ms(),
            state,
            attention,
            pending_tool,
            ended,
        })
    }

    fn valid(&self) -> bool {
        self.version == EVENT_VERSION
            && self.provider != ProcessProvider::Shell
            && !self.event.is_empty()
            && self.event.len() <= 80
            && !self.session_id.is_empty()
            && self.session_id.len() <= 256
            && self.pane_id.as_deref().is_none_or(valid_pane_id)
            && self.cwd.as_ref().is_none_or(|value| value.len() <= 2048)
            && self
                .pending_tool
                .as_ref()
                .is_none_or(|value| value.len() <= 80)
    }
}

#[derive(Debug, Clone)]
pub struct HookPaneState {
    pub state: HookAgentState,
    pub attention: Option<HookAttention>,
    pub updated_at_ms: u64,
}

#[derive(Clone, Default)]
pub struct HookRuntime {
    sessions: Arc<Mutex<HashMap<String, HookEventV1>>>,
    notify: Arc<Notify>,
}

impl HookRuntime {
    pub fn pane_state(&self, pane_id: &str, provider: ProcessProvider) -> Option<HookPaneState> {
        self.sessions
            .lock()
            .values()
            .filter(|event| {
                !event.ended
                    && event.provider == provider
                    && event.pane_id.as_deref() == Some(pane_id)
            })
            .max_by_key(|event| {
                let priority = match event.state {
                    HookAgentState::Waiting => 2,
                    HookAgentState::Working => 1,
                    HookAgentState::Idle => 0,
                };
                (priority, event.occurred_at_ms)
            })
            .map(|event| HookPaneState {
                state: event.state,
                attention: event.attention,
                updated_at_ms: event.occurred_at_ms,
            })
    }

    pub fn all_bound_panes(&self) -> HashSet<String> {
        self.sessions
            .lock()
            .values()
            .filter(|event| !event.ended)
            .filter_map(|event| event.pane_id.clone())
            .collect()
    }

    pub fn recent_attention(&self, age: Duration) -> bool {
        let cutoff = now_ms().saturating_sub(age.as_millis() as u64);
        self.sessions.lock().values().any(|event| {
            !event.ended && event.attention.is_some() && event.occurred_at_ms >= cutoff
        })
    }

    pub fn retain_live_panes(&self, live_panes: &HashSet<String>) {
        if live_panes.is_empty() {
            return;
        }
        let removed: Vec<String> = {
            let mut sessions = self.sessions.lock();
            let removed = sessions
                .iter()
                .filter(|(_, event)| {
                    event
                        .pane_id
                        .as_ref()
                        .is_some_and(|pane_id| !live_panes.contains(pane_id))
                })
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            sessions.retain(|key, _| !removed.contains(key));
            removed
        };
        for key in removed {
            let _ = fs::remove_file(sessions_dir().join(format!("{}.json", key)));
        }
    }

    pub fn bind_process_to_pane(
        &self,
        pane_id: &str,
        pane_pid: &str,
        provider: ProcessProvider,
        snapshot: &ProcessSnapshot,
    ) {
        let mut candidate_pids = HashSet::from([pane_pid.to_string()]);
        for child in snapshot.child_pids(pane_pid) {
            candidate_pids.insert(child.clone());
            candidate_pids.extend(snapshot.child_pids(child).iter().cloned());
        }
        let changed: Vec<HookEventV1> = {
            let mut sessions = self.sessions.lock();
            sessions
                .values_mut()
                .filter(|event| {
                    event.provider == provider
                        && event.pane_id.is_none()
                        && event
                            .process_id
                            .is_some_and(|pid| candidate_pids.contains(&pid.to_string()))
                })
                .map(|event| {
                    event.pane_id = Some(pane_id.to_string());
                    event.clone()
                })
                .collect()
        };
        for event in changed {
            persist_session_event(&event);
        }
    }

    pub async fn notified(&self) {
        self.notify.notified().await;
    }

    fn apply(&self, event: HookEventV1) {
        let key = session_key(event.provider, &event.session_id);
        let mut sessions = self.sessions.lock();
        if event.ended {
            sessions.remove(&key);
        } else {
            sessions.insert(key, event);
        }
        drop(sessions);
        self.notify.notify_waiters();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentIntegrationStatus {
    pub provider: ProcessProvider,
    pub detected: bool,
    pub configured: bool,
    pub active: bool,
    pub needs_repair: bool,
    pub needs_restart: bool,
    pub capabilities: Vec<String>,
    pub detail: String,
}

pub fn integration_statuses() -> Vec<AgentIntegrationStatus> {
    supported_providers()
        .into_iter()
        .map(|provider| {
            let detected = crate::tools::which(provider.binary_name()).is_some();
            let configured = provider_configured(provider);
            let helper_present = helper_path().is_file();
            let active = provider_has_active_marker(provider);
            let needs_repair = configured
                && (!provider_configuration_complete(provider)
                    || (provider != ProcessProvider::Opencode && !helper_present)
                    || (provider == ProcessProvider::Codex && codex_hooks_disabled()));
            let detail = if active {
                "Hook events received".to_string()
            } else if needs_repair {
                "Hook helper is missing or outdated".to_string()
            } else if configured {
                if provider == ProcessProvider::Codex {
                    "Enabled in Codex, but no events received; approve it in /hooks, then fully relaunch Codex"
                        .to_string()
                } else {
                    "Configured; restart running agent sessions".to_string()
                }
            } else if detected {
                "Available for setup".to_string()
            } else {
                "Agent binary not detected".to_string()
            };
            AgentIntegrationStatus {
                provider,
                detected,
                configured,
                active,
                needs_repair,
                needs_restart: configured && !active,
                capabilities: provider_capabilities(provider),
                detail,
            }
        })
        .collect()
}

pub fn install_provider(
    provider: ProcessProvider,
    helper_source: Option<&Path>,
) -> Result<(), String> {
    if !supported_providers().contains(&provider) {
        return Err("This provider does not support hooks".to_string());
    }
    if provider != ProcessProvider::Opencode {
        install_helper(helper_source)?;
    }
    match provider {
        ProcessProvider::Claude => install_claude(),
        ProcessProvider::Codex => install_codex(),
        ProcessProvider::Opencode => install_opencode(),
        ProcessProvider::Antigravity => install_antigravity(),
        ProcessProvider::Shell => unreachable!(),
    }
}

pub fn remove_provider(provider: ProcessProvider) -> Result<(), String> {
    match provider {
        ProcessProvider::Claude => remove_json_hooks(&claude_settings_path()),
        ProcessProvider::Codex => remove_json_hooks(&codex_hooks_path()),
        ProcessProvider::Opencode => remove_opencode(),
        ProcessProvider::Antigravity => remove_antigravity(),
        ProcessProvider::Shell => Err("Shell does not support hooks".to_string()),
    }
}

pub fn write_event(event: &HookEventV1) -> Result<(), String> {
    if !event.valid() {
        return Err("invalid hook event".to_string());
    }
    let dir = inbox_dir();
    create_private_dir(&dir)?;
    let file_name = format!("{}-{}.json", event.occurred_at_ms, uuid::Uuid::new_v4());
    atomic_write_json(&dir.join(file_name), event)
}

pub async fn run_event_watcher(
    runtime: HookRuntime,
    agent_activity: Arc<Mutex<Vec<AgentActivity>>>,
    event_sink: Arc<dyn EventSink>,
) {
    use notify::{RecommendedWatcher, RecursiveMode, Watcher};
    let inbox = inbox_dir();
    let sessions = sessions_dir();
    if let Err(error) = create_private_dir(&inbox).and_then(|_| create_private_dir(&sessions)) {
        log::warn!(
            "[agent-hooks] failed to prepare event directories: {}",
            error
        );
        return;
    }
    replay_session_markers(&runtime);
    process_inbox(&runtime, &agent_activity, event_sink.as_ref());

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = match RecommendedWatcher::new(
        move |result: notify::Result<notify::Event>| {
            if result.is_ok() {
                let _ = tx.send(());
            }
        },
        notify::Config::default(),
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            log::warn!("[agent-hooks] failed to create watcher: {}", error);
            return;
        }
    };
    if let Err(error) = watcher.watch(&inbox, RecursiveMode::NonRecursive) {
        log::warn!("[agent-hooks] failed to watch inbox: {}", error);
        return;
    }
    while rx.recv().await.is_some() {
        process_inbox(&runtime, &agent_activity, event_sink.as_ref());
    }
}

fn process_inbox(
    runtime: &HookRuntime,
    agent_activity: &Arc<Mutex<Vec<AgentActivity>>>,
    event_sink: &dyn EventSink,
) {
    let Ok(entries) = fs::read_dir(inbox_dir()) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    for path in paths {
        let event = read_event_file(&path);
        let _ = fs::remove_file(&path);
        let Some(event) = event else {
            continue;
        };
        persist_session_event(&event);
        runtime.apply(event.clone());
        if let Some(pane_id) = event.pane_id.as_deref() {
            let mut activity = agent_activity.lock().clone();
            activity.retain(|item| item.pane_id != pane_id);
            if let Some(state) = runtime.pane_state(pane_id, event.provider) {
                activity.push(AgentActivity {
                    pane_id: pane_id.to_string(),
                    working: state.state == HookAgentState::Working && state.attention.is_none(),
                    asking: state.state == HookAgentState::Waiting || state.attention.is_some(),
                });
            }
            activity.sort_by(|left, right| left.pane_id.cmp(&right.pane_id));
            *agent_activity.lock() = activity.clone();
            event_sink.emit_agent_activity_changed(activity);
        }
        log::debug!(
            "[agent-hooks] processed {} event for {}",
            event.event,
            event.provider.as_str()
        );
    }
}

fn read_event_file(path: &Path) -> Option<HookEventV1> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_EVENT_BYTES {
        return None;
    }
    let event: HookEventV1 = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    event.valid().then_some(event)
}

fn replay_session_markers(runtime: &HookRuntime) {
    let Ok(entries) = fs::read_dir(sessions_dir()) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        if let Some(event) = read_event_file(&path) {
            runtime.apply(event);
        }
    }
}

fn persist_session_event(event: &HookEventV1) {
    let path = sessions_dir().join(format!(
        "{}.json",
        session_key(event.provider, &event.session_id)
    ));
    if event.ended {
        let _ = fs::remove_file(path);
    } else if let Err(error) = atomic_write_json(&path, event) {
        log::debug!("[agent-hooks] failed to persist session state: {}", error);
    }
}

fn supported_providers() -> [ProcessProvider; 4] {
    [
        ProcessProvider::Claude,
        ProcessProvider::Codex,
        ProcessProvider::Opencode,
        ProcessProvider::Antigravity,
    ]
}

fn provider_capabilities(provider: ProcessProvider) -> Vec<String> {
    match provider {
        ProcessProvider::Claude | ProcessProvider::Codex | ProcessProvider::Opencode => {
            vec!["lifecycle".to_string(), "attention".to_string()]
        }
        ProcessProvider::Antigravity => vec!["lifecycle".to_string()],
        ProcessProvider::Shell => Vec::new(),
    }
}

fn hooks_root() -> PathBuf {
    crate::config::config_dir()
        .unwrap_or_else(|| PathBuf::from(".clawtab"))
        .join("agent-hooks")
}

pub fn helper_path() -> PathBuf {
    crate::config::config_dir()
        .unwrap_or_else(|| PathBuf::from(".clawtab"))
        .join("hooks")
        .join("clawtab-hook")
}

fn inbox_dir() -> PathBuf {
    hooks_root().join("inbox")
}

fn sessions_dir() -> PathBuf {
    hooks_root().join("sessions")
}

fn install_helper(source: Option<&Path>) -> Result<(), String> {
    let destination = helper_path();
    if let Some(parent) = destination.parent() {
        create_private_dir(parent)?;
    }
    if let Some(source) = source.filter(|path| path.is_file()) {
        fs::copy(source, &destination)
            .map_err(|error| format!("Failed to install hook helper: {}", error))?;
    } else if !destination.is_file() {
        return Err("The bundled clawtab-hook helper could not be found".to_string());
    }
    #[cfg(unix)]
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Failed to set hook helper permissions: {}", error))?;
    Ok(())
}

fn install_claude() -> Result<(), String> {
    let path = claude_settings_path();
    let command = helper_command(ProcessProvider::Claude);
    let entries = [
        ("SessionStart", "", "session_start"),
        ("UserPromptSubmit", "", "user_prompt_submit"),
        ("PermissionRequest", "", "permission_request"),
        ("PreToolUse", "AskUserQuestion", "ask_user_question"),
        ("PostToolUse", "AskUserQuestion", "post_question"),
        (
            "Notification",
            "idle_prompt|permission_prompt|elicitation_dialog",
            "notification",
        ),
        ("Stop", "", "stop"),
        ("SessionEnd", "", "session_end"),
    ];
    install_json_hooks(&path, &command, &entries, false)
}

fn install_codex() -> Result<(), String> {
    let path = codex_hooks_path();
    let command = helper_command(ProcessProvider::Codex);
    install_json_hooks(
        &path,
        &command,
        &[
            ("SessionStart", "startup|resume|clear", "session_start"),
            ("UserPromptSubmit", "", "user_prompt_submit"),
            ("PermissionRequest", "", "permission_request"),
            ("Stop", "", "stop"),
        ],
        true,
    )?;
    enable_codex_hooks()
}

fn install_antigravity() -> Result<(), String> {
    let path = antigravity_hooks_path();
    let existed = path.exists();
    let mut root = read_json_object(&path)?;
    backup_once(&path, existed)?;
    let command = shell_quote_path(&helper_path());
    root.insert(
        "clawtab".to_string(),
        json!({
            "PreInvocation": [{"type": "command", "command": format!("{} antigravity pre_invocation", command)}],
            "Stop": [{"type": "command", "command": format!("{} antigravity stop", command)}]
        }),
    );
    atomic_write_json_value(&path, &Value::Object(root))
}

fn install_opencode() -> Result<(), String> {
    let path = opencode_plugin_path();
    if path.exists() {
        let current = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
        if !current.contains(OPENCODE_SENTINEL) {
            return Err(format!(
                "Refused to overwrite unowned plugin {}",
                path.display()
            ));
        }
        backup_once(&path, true)?;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {}", parent.display(), error))?;
    }
    atomic_write(&path, opencode_plugin().as_bytes(), 0o600)?;
    let legacy = opencode_legacy_plugin_path();
    if legacy.exists()
        && fs::read_to_string(&legacy)
            .map(|value| value.contains(OPENCODE_SENTINEL))
            .unwrap_or(false)
    {
        fs::remove_file(legacy)
            .map_err(|error| format!("Failed to remove legacy plugin: {}", error))?;
    }
    Ok(())
}

fn install_json_hooks(
    path: &Path,
    command: &str,
    entries: &[(&str, &str, &str)],
    timeout_sec: bool,
) -> Result<(), String> {
    let existed = path.exists();
    let mut root = read_json_object(path)?;
    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| {
            format!(
                "Refused to modify {}: hooks must be an object",
                path.display()
            )
        })?;
    for (slot, matcher, event) in entries {
        let groups = hooks
            .entry((*slot).to_string())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| {
                format!(
                    "Refused to modify {}: {} must be an array",
                    path.display(),
                    slot
                )
            })?;
        remove_owned_groups(groups);
        let mut hook = json!({
            "type": "command",
            "command": format!("{} {}", command, event)
        });
        if timeout_sec {
            hook["timeoutSec"] = json!(1);
        }
        groups.push(json!({
            "matcher": matcher,
            "hooks": [hook]
        }));
    }
    backup_once(path, existed)?;
    atomic_write_json_value(path, &Value::Object(root))
}

fn remove_json_hooks(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_json_object(path)?;
    let mut changed = false;
    if let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        for groups in hooks.values_mut().filter_map(Value::as_array_mut) {
            let before = groups.len();
            remove_owned_groups(groups);
            changed |= groups.len() != before;
        }
        hooks.retain(|_, value| !value.as_array().is_some_and(Vec::is_empty));
    }
    if !changed {
        return Ok(());
    }
    atomic_write_json_value(path, &Value::Object(root))
}

fn remove_owned_groups(groups: &mut Vec<Value>) {
    groups.retain(|group| {
        !group
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hooks| {
                hooks.iter().any(|hook| {
                    hook.get("command")
                        .and_then(Value::as_str)
                        .is_some_and(is_owned_command)
                })
            })
    });
}

fn remove_antigravity() -> Result<(), String> {
    let path = antigravity_hooks_path();
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_json_object(&path)?;
    if root.remove("clawtab").is_none() {
        return Ok(());
    }
    atomic_write_json_value(&path, &Value::Object(root))
}

fn remove_opencode() -> Result<(), String> {
    for path in [opencode_plugin_path(), opencode_legacy_plugin_path()] {
        if !path.exists() {
            continue;
        }
        let contents = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
        if contents.contains(OPENCODE_SENTINEL) {
            fs::remove_file(&path)
                .map_err(|error| format!("Failed to remove {}: {}", path.display(), error))?;
        }
    }
    Ok(())
}

fn provider_configured(provider: ProcessProvider) -> bool {
    match provider {
        ProcessProvider::Claude => json_hooks_configured(&claude_settings_path()),
        ProcessProvider::Codex => json_hooks_configured(&codex_hooks_path()),
        ProcessProvider::Opencode => [opencode_plugin_path(), opencode_legacy_plugin_path()]
            .into_iter()
            .any(|path| {
                fs::read_to_string(path)
                    .map(|value| value.contains(OPENCODE_SENTINEL))
                    .unwrap_or(false)
            }),
        ProcessProvider::Antigravity => read_json_object(&antigravity_hooks_path())
            .ok()
            .and_then(|root| root.get("clawtab").cloned())
            .is_some(),
        ProcessProvider::Shell => false,
    }
}

fn provider_configuration_complete(provider: ProcessProvider) -> bool {
    match provider {
        ProcessProvider::Claude => {
            let slots = owned_hook_slots(&claude_settings_path());
            [
                "SessionStart",
                "UserPromptSubmit",
                "PermissionRequest",
                "PreToolUse",
                "PostToolUse",
                "Notification",
                "Stop",
                "SessionEnd",
            ]
            .into_iter()
            .all(|slot| slots.contains(slot))
        }
        ProcessProvider::Codex => {
            let slots = owned_hook_slots(&codex_hooks_path());
            [
                "SessionStart",
                "UserPromptSubmit",
                "PermissionRequest",
                "Stop",
            ]
            .into_iter()
            .all(|slot| slots.contains(slot))
                && !codex_hooks_disabled()
        }
        ProcessProvider::Opencode => provider_configured(provider),
        ProcessProvider::Antigravity => read_json_object(&antigravity_hooks_path())
            .ok()
            .and_then(|root| root.get("clawtab").cloned())
            .is_some_and(|hook| {
                hook.get("PreInvocation")
                    .and_then(Value::as_array)
                    .is_some()
                    && hook.get("Stop").and_then(Value::as_array).is_some()
            }),
        ProcessProvider::Shell => false,
    }
}

fn json_hooks_configured(path: &Path) -> bool {
    !owned_hook_slots(path).is_empty()
}

fn owned_hook_slots(path: &Path) -> HashSet<String> {
    read_json_object(path)
        .ok()
        .and_then(|root| root.get("hooks").cloned())
        .and_then(|hooks| hooks.as_object().cloned())
        .map(|hooks| {
            hooks
                .into_iter()
                .filter_map(|(slot, groups)| {
                    groups
                        .as_array()
                        .is_some_and(|groups| {
                            groups.iter().any(|group| {
                                group
                                    .get("hooks")
                                    .and_then(Value::as_array)
                                    .is_some_and(|hooks| {
                                        hooks.iter().any(|hook| {
                                            hook.get("command")
                                                .and_then(Value::as_str)
                                                .is_some_and(is_owned_command)
                                        })
                                    })
                            })
                        })
                        .then_some(slot)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn provider_has_active_marker(provider: ProcessProvider) -> bool {
    let Ok(entries) = fs::read_dir(sessions_dir()) else {
        return false;
    };
    entries
        .flatten()
        .filter_map(|entry| read_event_file(&entry.path()))
        .any(|event| event.provider == provider && !event.ended)
}

fn enable_codex_hooks() -> Result<(), String> {
    let path = codex_home().join("config.toml");
    let original = fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = original.lines().map(str::to_string).collect();
    if let Some(start) = lines.iter().position(|line| line.trim() == "[features]") {
        let end = lines
            .iter()
            .enumerate()
            .skip(start + 1)
            .find(|(_, line)| line.trim().starts_with('['))
            .map(|(index, _)| index)
            .unwrap_or(lines.len());
        let mut key_index = None;
        let mut duplicate_indices = Vec::new();
        for (index, line) in lines.iter().enumerate().take(end).skip(start + 1) {
            let trimmed = line.trim();
            if trimmed.starts_with("hooks =") || trimmed.starts_with("codex_hooks =") {
                if key_index.is_none() {
                    key_index = Some(index);
                } else {
                    duplicate_indices.push(index);
                }
            }
        }
        for index in duplicate_indices.into_iter().rev() {
            lines.remove(index);
        }
        if let Some(index) = key_index {
            lines[index] = "hooks = true".to_string();
        } else {
            lines.insert(end, "hooks = true".to_string());
        }
    } else {
        if !lines.is_empty() && !lines.last().is_some_and(String::is_empty) {
            lines.push(String::new());
        }
        lines.push("[features]".to_string());
        lines.push("hooks = true".to_string());
    }
    let contents = format!("{}\n", lines.join("\n"));
    backup_once(&path, path.exists())?;
    atomic_write(&path, contents.as_bytes(), 0o600)
}

fn codex_hooks_disabled() -> bool {
    let Ok(contents) = fs::read_to_string(codex_home().join("config.toml")) else {
        return false;
    };
    let mut in_features = false;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_features = trimmed == "[features]";
            continue;
        }
        if in_features && (trimmed == "hooks = false" || trimmed == "codex_hooks = false") {
            return true;
        }
    }
    false
}

fn helper_command(provider: ProcessProvider) -> String {
    format!("{} {}", shell_quote_path(&helper_path()), provider.as_str())
}

fn shell_quote_path(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn is_owned_command(command: &str) -> bool {
    command.contains(OWNED_COMMAND_FRAGMENT) || command.contains("clawtab-hook")
}

fn read_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
    serde_json::from_str::<Value>(&contents)
        .map_err(|error| format!("Refused to modify malformed {}: {}", path.display(), error))?
        .as_object()
        .cloned()
        .ok_or_else(|| {
            format!(
                "Refused to modify {}: top level must be an object",
                path.display()
            )
        })
}

fn backup_once(path: &Path, existed: bool) -> Result<(), String> {
    if !existed {
        return Ok(());
    }
    let backup = PathBuf::from(format!("{}.clawtab-backup", path.display()));
    if !backup.exists() {
        fs::copy(path, backup)
            .map_err(|error| format!("Failed to back up {}: {}", path.display(), error))?;
    }
    Ok(())
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("Failed to serialize hook event: {}", error))?;
    atomic_write(path, &bytes, 0o600)
}

fn atomic_write_json_value(path: &Path, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {}", path.display(), error))?;
    bytes.push(b'\n');
    atomic_write(path, &bytes, 0o600)
}

fn atomic_write(path: &Path, contents: &[u8], mode: u32) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {}", parent.display(), error))?;
    let temp = parent.join(format!(".clawtab-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(mode);
    let mut file = options
        .open(&temp)
        .map_err(|error| format!("Failed to create {}: {}", temp.display(), error))?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to write {}: {}", temp.display(), error))?;
    fs::rename(&temp, path)
        .map_err(|error| format!("Failed to replace {}: {}", path.display(), error))
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create {}: {}", path.display(), error))?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Failed to secure {}: {}", path.display(), error))?;
    Ok(())
}

fn claude_settings_path() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
        .unwrap_or_else(|| PathBuf::from(".claude"))
        .join("settings.json")
}

fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

fn codex_hooks_path() -> PathBuf {
    codex_home().join("hooks.json")
}

fn antigravity_hooks_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".gemini/config/hooks.json")
}

fn opencode_config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
        .unwrap_or_else(|| PathBuf::from(".config"))
        .join("opencode")
}

fn opencode_plugin_path() -> PathBuf {
    opencode_config_dir().join("plugins/clawtab.js")
}

fn opencode_legacy_plugin_path() -> PathBuf {
    opencode_config_dir().join("plugin/clawtab.js")
}

fn valid_pane_id(value: &str) -> bool {
    value.strip_prefix('%').is_some_and(|rest| {
        !rest.is_empty() && rest.chars().all(|character| character.is_ascii_digit())
    })
}

fn session_key(provider: ProcessProvider, session_id: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    provider.hash(&mut hasher);
    session_id.hash(&mut hasher);
    format!("{}-{:016x}", provider.as_str(), hasher.finish())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn opencode_plugin() -> String {
    let inbox = inbox_dir()
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!(
        r#"{sentinel}
import {{ mkdir, rename, writeFile }} from "node:fs/promises"
import {{ randomUUID }} from "node:crypto"

const inbox = "{inbox}"

const emit = async (event, state, attention = null, ended = false) => {{
  const properties = event?.properties ?? {{}}
  const sessionId = properties.sessionID ?? properties.sessionId ?? properties.id
  if (!sessionId) return
  const paneId = /^%\d+$/.test(process.env.TMUX_PANE ?? "") ? process.env.TMUX_PANE : null
  const payload = {{
    version: 1,
    provider: "opencode",
    event: event.type,
    session_id: String(sessionId),
    pane_id: paneId,
    process_id: process.pid,
    cwd: typeof properties.directory === "string" ? properties.directory : null,
    occurred_at_ms: Date.now(),
    state,
    attention,
    pending_tool: null,
    ended,
  }}
  await mkdir(inbox, {{ recursive: true, mode: 0o700 }})
  const name = `${{Date.now()}}-${{randomUUID()}}.json`
  const temporary = `${{inbox}}/.${{name}}.tmp`
  await writeFile(temporary, JSON.stringify(payload), {{ mode: 0o600 }})
  await rename(temporary, `${{inbox}}/${{name}}`)
}}

export const ClawTab = async () => ({{
  event: async ({{ event }}) => {{
    try {{
      if (event.type === "session.created") await emit(event, "idle")
      else if (event.type === "session.deleted") await emit(event, "idle", null, true)
      else if (event.type === "session.idle") await emit(event, "idle")
      else if (event.type === "permission.asked") await emit(event, "waiting", "permission")
      else if (event.type === "permission.replied") await emit(event, "working")
      else if (event.type === "session.status") {{
        const status = event.properties?.status?.type ?? event.properties?.status
        await emit(event, status === "idle" ? "idle" : "working")
      }}
    }} catch {{
      // Hooks must never interfere with OpenCode.
    }}
  }},
}})
"#,
        sentinel = OPENCODE_SENTINEL,
        inbox = inbox
    )
}

#[cfg(test)]
mod tests {
    use super::{
        install_json_hooks, remove_json_hooks, HookAgentState, HookAttention, HookEventV1,
        HookRuntime,
    };
    use crate::agent_session::ProcessProvider;
    use serde_json::json;
    use std::fs;

    #[test]
    fn normalizes_permission_without_persisting_tool_input() {
        let event = HookEventV1::from_provider_payload(
            ProcessProvider::Codex,
            "permission_request",
            &json!({
                "session_id": "session-1",
                "cwd": "/tmp/project",
                "tool_name": "Bash",
                "tool_input": {"command": "secret command"}
            }),
            Some("%7".to_string()),
            Some(42),
        )
        .expect("event");
        assert_eq!(event.state, HookAgentState::Waiting);
        assert_eq!(event.attention, Some(HookAttention::Permission));
        let serialized = serde_json::to_string(&event).expect("json");
        assert!(!serialized.contains("secret command"));
    }

    #[test]
    fn rejects_invalid_session_and_pane_values() {
        assert!(HookEventV1::from_provider_payload(
            ProcessProvider::Claude,
            "session_start",
            &json!({"session_id": ""}),
            None,
            None,
        )
        .is_none());
        let event = HookEventV1::from_provider_payload(
            ProcessProvider::Claude,
            "session_start",
            &json!({"session_id": "ok"}),
            Some("../../pane".to_string()),
            None,
        )
        .expect("event");
        assert!(event.pane_id.is_none());
    }

    #[test]
    fn hook_install_and_remove_preserve_unrelated_entries() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("settings.json");
        fs::write(
            &path,
            r#"{"theme":"dark","hooks":{"Stop":[{"hooks":[{"type":"command","command":"other-hook"}]}]}}"#,
        )
        .expect("fixture");
        install_json_hooks(
            &path,
            "'/tmp/.config/clawtab/hooks/clawtab-hook' codex",
            &[("Stop", "", "stop")],
            true,
        )
        .expect("install");
        install_json_hooks(
            &path,
            "'/tmp/.config/clawtab/hooks/clawtab-hook' codex",
            &[("Stop", "", "stop")],
            true,
        )
        .expect("repair");
        let installed = fs::read_to_string(&path).expect("installed");
        assert!(installed.contains("other-hook"));
        assert!(installed.contains("clawtab-hook"));
        assert_eq!(installed.matches("clawtab-hook").count(), 1);
        assert!(directory
            .path()
            .join("settings.json.clawtab-backup")
            .is_file());
        remove_json_hooks(&path).expect("remove");
        let removed = fs::read_to_string(path).expect("removed");
        assert!(removed.contains("other-hook"));
        assert!(!removed.contains("clawtab-hook"));
    }

    #[test]
    fn malformed_hook_config_is_refused() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("settings.json");
        fs::write(&path, "{bad json").expect("fixture");
        let error = install_json_hooks(
            &path,
            "'/tmp/.config/clawtab/hooks/clawtab-hook' claude",
            &[("Stop", "", "stop")],
            false,
        )
        .expect_err("malformed config must fail");
        assert!(error.contains("Refused to modify malformed"));
        assert_eq!(fs::read_to_string(path).expect("unchanged"), "{bad json");
    }

    #[test]
    fn pane_state_aggregates_waiting_above_working() {
        let runtime = HookRuntime::default();
        runtime.apply(HookEventV1 {
            version: 1,
            provider: ProcessProvider::Opencode,
            event: "session.status".to_string(),
            session_id: "working-session".to_string(),
            pane_id: Some("%9".to_string()),
            process_id: Some(1),
            cwd: None,
            occurred_at_ms: 10,
            state: HookAgentState::Working,
            attention: None,
            pending_tool: None,
            ended: false,
        });
        runtime.apply(HookEventV1 {
            version: 1,
            provider: ProcessProvider::Opencode,
            event: "permission.asked".to_string(),
            session_id: "waiting-session".to_string(),
            pane_id: Some("%9".to_string()),
            process_id: Some(1),
            cwd: None,
            occurred_at_ms: 11,
            state: HookAgentState::Waiting,
            attention: Some(HookAttention::Permission),
            pending_tool: None,
            ended: false,
        });
        let state = runtime
            .pane_state("%9", ProcessProvider::Opencode)
            .expect("pane state");
        assert_eq!(state.state, HookAgentState::Waiting);
        assert_eq!(state.attention, Some(HookAttention::Permission));
    }
}
