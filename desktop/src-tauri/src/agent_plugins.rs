use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use clawtab_protocol::{
    AgentActionDescriptor, AgentActionParameter, AgentActionParameterKind, AgentActionParameters,
    AgentActionRun, AgentActionRunState, AgentSessionData,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::agent_session::{self, ProcessProvider};
use crate::config::settings::AppSettings;

const RUN_RETENTION: Duration = Duration::from_secs(15 * 60);
const DEFAULT_TIMEOUT_SECONDS: u64 = 10 * 60;
const MAX_TIMEOUT_SECONDS: u64 = 60 * 60;
const MAX_CAPTURE_BYTES: usize = 64 * 1024;
const MAX_RESULT_BYTES: usize = 64 * 1024;
const MODEL_VERIFY_TIMEOUT: Duration = Duration::from_secs(12);
const ALLOWED_CAPABILITIES: [&str; 5] = [
    "agent.read",
    "pane.input",
    "agent.wait",
    "agent.model",
    "composer.draft",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PluginManifest {
    schema_version: u32,
    id: String,
    name: String,
    version: String,
    actions: Vec<PluginAction>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PluginAction {
    id: String,
    title: String,
    #[serde(default)]
    description: String,
    command: Vec<String>,
    activation: PluginActivation,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    parameters: Vec<PluginParameter>,
    #[serde(default = "default_timeout_seconds")]
    timeout_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PluginActivation {
    providers: Vec<String>,
    #[serde(default)]
    versions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PluginParameter {
    name: String,
    title: String,
    #[serde(default)]
    description: Option<String>,
    kind: AgentActionParameterKind,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    default_value: Option<String>,
    #[serde(default)]
    placeholder: Option<String>,
    #[serde(default)]
    options: Vec<String>,
}

#[derive(Debug, Clone)]
struct LoadedPlugin {
    root: PathBuf,
    manifest: PluginManifest,
    fingerprint: String,
    validation_error: Option<String>,
}

#[derive(Debug, Clone)]
struct ExecutionSpec {
    plugin: LoadedPlugin,
    action: PluginAction,
}

#[derive(Debug, Clone)]
struct BaselineState {
    model: Option<String>,
    effort: Option<String>,
}

#[derive(Debug, Clone)]
struct HostRun {
    token: String,
    plugin_id: String,
    action_id: String,
    pane_id: String,
    pane_pid: String,
    provider: ProcessProvider,
    provider_version: Option<String>,
    working_directory: String,
    parameters: AgentActionParameters,
    capabilities: HashSet<String>,
    baseline: BaselineState,
    stashed_draft: Option<String>,
    model_changed: bool,
}

#[derive(Clone)]
struct StoredRun {
    run: AgentActionRun,
    updated_at: Instant,
    cancel: CancellationToken,
    host: HostRun,
}

type RunObserver = Arc<dyn Fn(AgentActionRun) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledPluginSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub fingerprint: String,
    pub trusted: bool,
    pub actions: Vec<String>,
    pub commands: Vec<Vec<String>>,
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRunContext {
    pub plugin_id: String,
    pub action_id: String,
    pub run_id: String,
    pub pane_id: String,
    pub provider: String,
    pub provider_version: Option<String>,
    pub working_directory: String,
    pub parameters: AgentActionParameters,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginAgentState {
    pub provider: String,
    pub idle: bool,
    pub busy: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub draft_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginHostCommand {
    pub token: String,
    pub request: PluginHostRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PluginHostRequest {
    Context,
    Progress {
        message: String,
        percent: u8,
    },
    SetResult {
        value: serde_json::Value,
    },
    AgentSession,
    AgentState,
    PaneSendText {
        text: String,
    },
    PaneSendKey {
        key: String,
    },
    PaneSubmitText {
        text: String,
    },
    AgentWaitState {
        state: String,
        timeout_ms: u64,
    },
    AgentSelectModel {
        model: String,
        effort: Option<String>,
    },
    AgentRestoreBaseline,
    ComposerStash,
    ComposerRestore,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PluginHostResponse {
    Ok,
    Context { context: PluginRunContext },
    Session { session: AgentSessionData },
    State { state: PluginAgentState },
    Composer { had_draft: bool },
    Error { error: String },
}

#[derive(Default)]
pub struct AgentPluginRuntime {
    runs: Mutex<HashMap<String, StoredRun>>,
    tokens: Mutex<HashMap<String, String>>,
    active_panes: Mutex<HashSet<String>>,
    observer: Mutex<Option<RunObserver>>,
}

pub fn runtime() -> &'static Arc<AgentPluginRuntime> {
    static RUNTIME: OnceLock<Arc<AgentPluginRuntime>> = OnceLock::new();
    RUNTIME.get_or_init(|| Arc::new(AgentPluginRuntime::default()))
}

impl AgentPluginRuntime {
    pub fn set_observer(&self, observer: RunObserver) {
        *self.observer.lock() = Some(observer);
    }

    pub fn list_actions(
        &self,
        pane_id: &str,
        settings: &AppSettings,
    ) -> (Vec<AgentActionDescriptor>, Option<AgentSessionData>) {
        let Some((provider, pane_pid)) = pane_context(pane_id) else {
            return (Vec::new(), None);
        };
        let version = provider_version(provider);
        let session = Some(session_data(provider, &pane_pid));
        let trusted = load_trust_store();
        let actions = discover_plugins()
            .into_iter()
            .filter_map(Result::ok)
            .flat_map(|plugin| {
                let plugin_trusted = plugin.validation_error.is_none()
                    && trusted.get(&plugin.manifest.id) == Some(&plugin.fingerprint);
                plugin
                    .manifest
                    .actions
                    .clone()
                    .into_iter()
                    .filter(|action| activation_matches(action, provider, version.as_deref()))
                    .map(move |action| {
                        descriptor(&plugin, action, provider, settings, plugin_trusted)
                    })
            })
            .collect();
        (actions, session)
    }

    pub fn list_installed_plugins(&self) -> Vec<InstalledPluginSummary> {
        let trusted = load_trust_store();
        discover_plugins()
            .into_iter()
            .map(|result| match result {
                Ok(plugin) => {
                    let mut capabilities = plugin
                        .manifest
                        .actions
                        .iter()
                        .flat_map(|action| action.capabilities.clone())
                        .collect::<Vec<_>>();
                    capabilities.sort();
                    capabilities.dedup();
                    InstalledPluginSummary {
                        id: plugin.manifest.id.clone(),
                        name: plugin.manifest.name.clone(),
                        version: plugin.manifest.version.clone(),
                        fingerprint: plugin.fingerprint.clone(),
                        trusted: plugin.validation_error.is_none()
                            && trusted.get(&plugin.manifest.id) == Some(&plugin.fingerprint),
                        actions: plugin
                            .manifest
                            .actions
                            .iter()
                            .map(|action| full_action_id(&plugin.manifest.id, &action.id))
                            .collect(),
                        commands: plugin
                            .manifest
                            .actions
                            .iter()
                            .map(|action| action.command.clone())
                            .collect(),
                        capabilities,
                        error: plugin.validation_error,
                    }
                }
                Err((id, error)) => InstalledPluginSummary {
                    id,
                    name: String::new(),
                    version: String::new(),
                    fingerprint: String::new(),
                    trusted: false,
                    actions: Vec::new(),
                    commands: Vec::new(),
                    capabilities: Vec::new(),
                    error: Some(error),
                },
            })
            .collect()
    }

    pub fn approve_plugin(&self, plugin_id: &str, fingerprint: &str) -> Result<(), String> {
        let plugin = discover_plugins()
            .into_iter()
            .filter_map(Result::ok)
            .find(|plugin| plugin.validation_error.is_none() && plugin.manifest.id == plugin_id)
            .ok_or_else(|| format!("Plugin not found: {plugin_id}"))?;
        if plugin.fingerprint != fingerprint {
            return Err("Plugin changed before approval; refresh and review it again".into());
        }
        let mut trusted = load_trust_store();
        trusted.insert(plugin_id.to_string(), fingerprint.to_string());
        save_trust_store(&trusted)
    }

    pub fn revoke_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let mut trusted = load_trust_store();
        trusted.remove(plugin_id);
        save_trust_store(&trusted)
    }

    pub fn start(
        self: &Arc<Self>,
        pane_id: String,
        action_id: String,
        parameters: AgentActionParameters,
        settings: AppSettings,
    ) -> Result<AgentActionRun, String> {
        let (provider, pane_pid) = pane_context(&pane_id)
            .ok_or_else(|| "No supported agent is running in this pane".to_string())?;
        let version = provider_version(provider);
        let spec = resolve_execution_spec(&action_id, provider, version.as_deref())?;
        let trusted = load_trust_store();
        if trusted.get(&spec.plugin.manifest.id) != Some(&spec.plugin.fingerprint) {
            return Err("Approve this plugin in ClawTab settings before running it".into());
        }
        validate_command(&spec.plugin.root, &spec.action.command)?;
        let parameters = validate_parameters(&spec.action, parameters, provider, &settings)?;
        {
            let mut panes = self.active_panes.lock();
            if !panes.insert(pane_id.clone()) {
                return Err("Another agent action is already running in this pane".into());
            }
        }

        self.prune_runs();
        let run_id = uuid::Uuid::new_v4().to_string();
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let cancel = CancellationToken::new();
        let session = session_data(provider, &pane_pid);
        let host = HostRun {
            token: token.clone(),
            plugin_id: spec.plugin.manifest.id.clone(),
            action_id: action_id.clone(),
            pane_id: pane_id.clone(),
            pane_pid,
            provider,
            provider_version: version,
            working_directory: pane_working_directory(&pane_id).unwrap_or_default(),
            parameters: parameters.clone(),
            capabilities: spec.action.capabilities.iter().cloned().collect(),
            baseline: BaselineState {
                model: session.model.clone(),
                effort: session.effort.clone(),
            },
            stashed_draft: None,
            model_changed: false,
        };
        let run = AgentActionRun {
            run_id: run_id.clone(),
            pane_id: pane_id.clone(),
            action_id,
            state: AgentActionRunState::Queued,
            progress: "Queued".into(),
            progress_percent: 0,
            result: None,
            error: None,
        };
        self.tokens.lock().insert(token, run_id.clone());
        self.runs.lock().insert(
            run_id.clone(),
            StoredRun {
                run: run.clone(),
                updated_at: Instant::now(),
                cancel: cancel.clone(),
                host,
            },
        );
        self.notify(run.clone());
        let runtime = Arc::clone(self);
        tokio::spawn(async move {
            runtime.execute(run_id, spec, cancel).await;
        });
        Ok(run)
    }

    pub fn get_run(&self, run_id: &str) -> Option<AgentActionRun> {
        self.prune_runs();
        self.runs
            .lock()
            .get(run_id)
            .map(|stored| stored.run.clone())
    }

    pub fn cancel(&self, run_id: &str) -> Result<AgentActionRun, String> {
        let stored = self
            .runs
            .lock()
            .get(run_id)
            .cloned()
            .ok_or_else(|| "Agent action run not found".to_string())?;
        if !stored.run.state.is_terminal() {
            stored.cancel.cancel();
        }
        Ok(stored.run)
    }

    pub async fn host_call(
        &self,
        token: &str,
        request: PluginHostRequest,
    ) -> Result<PluginHostResponse, String> {
        let run_id = self
            .tokens
            .lock()
            .get(token)
            .cloned()
            .ok_or_else(|| "Plugin run token is invalid or expired".to_string())?;
        let stored = self
            .runs
            .lock()
            .get(&run_id)
            .cloned()
            .ok_or_else(|| "Plugin run no longer exists".to_string())?;
        if stored.host.token != token || stored.run.state.is_terminal() {
            return Err("Plugin run token is invalid or expired".into());
        }

        match request {
            PluginHostRequest::Context => Ok(PluginHostResponse::Context {
                context: PluginRunContext {
                    plugin_id: stored.host.plugin_id,
                    action_id: stored.host.action_id,
                    run_id,
                    pane_id: stored.host.pane_id,
                    provider: stored.host.provider.as_str().into(),
                    provider_version: stored.host.provider_version,
                    working_directory: stored.host.working_directory,
                    parameters: stored.host.parameters,
                },
            }),
            PluginHostRequest::Progress { message, percent } => {
                validate_progress(&message, percent)?;
                self.update_progress(&run_id, &message, percent);
                Ok(PluginHostResponse::Ok)
            }
            PluginHostRequest::SetResult { value } => {
                if serde_json::to_vec(&value)
                    .map_err(|error| error.to_string())?
                    .len()
                    > MAX_RESULT_BYTES
                {
                    return Err("Plugin result is too large".into());
                }
                self.set_result(&run_id, value);
                Ok(PluginHostResponse::Ok)
            }
            PluginHostRequest::AgentSession => {
                require_capability(&stored.host, "agent.read")?;
                validate_bound_pane(&stored.host)?;
                Ok(PluginHostResponse::Session {
                    session: session_data(stored.host.provider, &stored.host.pane_pid),
                })
            }
            PluginHostRequest::AgentState => {
                require_capability(&stored.host, "agent.read")?;
                validate_bound_pane(&stored.host)?;
                Ok(PluginHostResponse::State {
                    state: agent_state(&stored.host)?,
                })
            }
            PluginHostRequest::PaneSendText { text } => {
                require_capability(&stored.host, "pane.input")?;
                validate_bound_pane(&stored.host)?;
                validate_input(&text)?;
                crate::tmux::send_literal_to_pane(&stored.host.pane_id, &text)?;
                Ok(PluginHostResponse::Ok)
            }
            PluginHostRequest::PaneSendKey { key } => {
                require_capability(&stored.host, "pane.input")?;
                validate_bound_pane(&stored.host)?;
                validate_key(&key)?;
                crate::tmux::send_key_to_pane(&stored.host.pane_id, &key)?;
                Ok(PluginHostResponse::Ok)
            }
            PluginHostRequest::PaneSubmitText { text } => {
                require_capability(&stored.host, "pane.input")?;
                validate_bound_pane(&stored.host)?;
                validate_input(&text)?;
                submit_text(&stored.host.pane_id, stored.host.provider, &text)?;
                Ok(PluginHostResponse::Ok)
            }
            PluginHostRequest::AgentWaitState { state, timeout_ms } => {
                require_capability(&stored.host, "agent.wait")?;
                validate_bound_pane(&stored.host)?;
                wait_for_state(
                    &stored.host,
                    &state,
                    Duration::from_millis(timeout_ms.min(60_000)),
                    &stored.cancel,
                )
                .await?;
                Ok(PluginHostResponse::Ok)
            }
            PluginHostRequest::AgentSelectModel { model, effort } => {
                require_capability(&stored.host, "agent.model")?;
                validate_bound_pane(&stored.host)?;
                validate_model_value(&model)?;
                if let Some(value) = effort.as_deref() {
                    validate_effort(value)?;
                }
                select_model(&stored.host, &model, effort.as_deref(), &stored.cancel).await?;
                if let Some(run) = self.runs.lock().get_mut(&run_id) {
                    run.host.model_changed = true;
                }
                Ok(PluginHostResponse::Ok)
            }
            PluginHostRequest::AgentRestoreBaseline => {
                require_capability(&stored.host, "agent.model")?;
                validate_bound_pane(&stored.host)?;
                restore_baseline(&stored.host, &stored.cancel).await?;
                if let Some(run) = self.runs.lock().get_mut(&run_id) {
                    run.host.model_changed = false;
                }
                Ok(PluginHostResponse::Ok)
            }
            PluginHostRequest::ComposerStash => {
                require_capability(&stored.host, "composer.draft")?;
                validate_bound_pane(&stored.host)?;
                let draft = stash_draft(&stored.host)?;
                let had_draft = draft.is_some();
                if let Some(run) = self.runs.lock().get_mut(&run_id) {
                    run.host.stashed_draft = draft;
                }
                Ok(PluginHostResponse::Composer { had_draft })
            }
            PluginHostRequest::ComposerRestore => {
                require_capability(&stored.host, "composer.draft")?;
                validate_bound_pane(&stored.host)?;
                restore_stashed_draft(&stored.host)?;
                if let Some(run) = self.runs.lock().get_mut(&run_id) {
                    run.host.stashed_draft = None;
                }
                Ok(PluginHostResponse::Ok)
            }
        }
    }

    async fn execute(&self, run_id: String, spec: ExecutionSpec, cancel: CancellationToken) {
        self.update_progress(&run_id, "Starting plugin", 5);
        let host = match self.runs.lock().get(&run_id).cloned() {
            Some(stored) => stored.host,
            None => return,
        };
        let result = run_plugin_process(&spec, &host, &cancel).await;
        let cancelled = cancel.is_cancelled();
        cancel.cancel();
        let latest_host = self
            .runs
            .lock()
            .get(&run_id)
            .map(|stored| stored.host.clone())
            .unwrap_or_else(|| host.clone());
        if result.is_err() || cancelled {
            self.update_progress(&run_id, "Recovering previous state", 90);
            if let Err(recovery_error) = recover_host_state(&latest_host).await {
                self.finish(
                    &run_id,
                    AgentActionRunState::NeedsUserAttention,
                    Some(format!(
                        "Plugin stopped and recovery failed: {recovery_error}"
                    )),
                );
                self.cleanup_run(&run_id, &latest_host);
                return;
            }
        }
        match result {
            Ok(()) if cancelled => self.finish(&run_id, AgentActionRunState::Cancelled, None),
            Ok(()) => self.finish(&run_id, AgentActionRunState::Succeeded, None),
            Err(error) if cancelled => {
                self.finish(&run_id, AgentActionRunState::Cancelled, Some(error))
            }
            Err(error) => self.finish(&run_id, AgentActionRunState::Failed, Some(error)),
        }
        self.cleanup_run(&run_id, &latest_host);
    }

    fn update_progress(&self, run_id: &str, progress: &str, percent: u8) {
        let updated = if let Some(stored) = self.runs.lock().get_mut(run_id) {
            stored.run.state = AgentActionRunState::Running;
            stored.run.progress = progress.to_string();
            stored.run.progress_percent = percent;
            stored.updated_at = Instant::now();
            Some(stored.run.clone())
        } else {
            None
        };
        if let Some(run) = updated {
            self.notify(run);
        }
    }

    fn set_result(&self, run_id: &str, value: serde_json::Value) {
        let updated = if let Some(stored) = self.runs.lock().get_mut(run_id) {
            stored.run.result = Some(value);
            stored.updated_at = Instant::now();
            Some(stored.run.clone())
        } else {
            None
        };
        if let Some(run) = updated {
            self.notify(run);
        }
    }

    fn finish(&self, run_id: &str, state: AgentActionRunState, error: Option<String>) {
        let updated = if let Some(stored) = self.runs.lock().get_mut(run_id) {
            stored.run.state = state;
            stored.run.progress = if stored.run.state == AgentActionRunState::Succeeded {
                "Complete".into()
            } else {
                "Stopped".into()
            };
            stored.run.progress_percent = 100;
            stored.run.error = error;
            stored.updated_at = Instant::now();
            Some(stored.run.clone())
        } else {
            None
        };
        if let Some(run) = updated {
            self.notify(run);
        }
    }

    fn cleanup_run(&self, run_id: &str, host: &HostRun) {
        self.tokens.lock().remove(&host.token);
        self.active_panes.lock().remove(&host.pane_id);
        if let Some(stored) = self.runs.lock().get_mut(run_id) {
            stored.cancel.cancel();
            stored.updated_at = Instant::now();
        }
    }

    fn notify(&self, run: AgentActionRun) {
        if let Some(observer) = self.observer.lock().clone() {
            observer(run);
        }
    }

    fn prune_runs(&self) {
        self.runs.lock().retain(|_, stored| {
            !stored.run.state.is_terminal() || stored.updated_at.elapsed() < RUN_RETENTION
        });
    }
}

fn default_timeout_seconds() -> u64 {
    DEFAULT_TIMEOUT_SECONDS
}

fn plugin_root() -> Option<PathBuf> {
    crate::config::config_dir().map(|path| path.join("agent-plugins"))
}

fn trust_store_path() -> Option<PathBuf> {
    crate::config::config_dir().map(|path| path.join("plugin-trust.json"))
}

fn discover_plugins() -> Vec<Result<LoadedPlugin, (String, String)>> {
    let Some(root) = plugin_root() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut directories = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    directories.sort();
    directories.into_iter().map(load_plugin).collect()
}

fn load_plugin(root: PathBuf) -> Result<LoadedPlugin, (String, String)> {
    let folder_id = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("invalid")
        .to_string();
    let manifest_path = root.join("plugin.yaml");
    let bytes = std::fs::read(&manifest_path).map_err(|error| {
        (
            folder_id.clone(),
            format!("Could not read plugin.yaml: {error}"),
        )
    })?;
    if bytes.len() > 256 * 1024 {
        return Err((folder_id, "plugin.yaml is larger than 256 KiB".into()));
    }
    let manifest: PluginManifest = serde_yml::from_slice(&bytes)
        .map_err(|error| (folder_id.clone(), format!("Invalid plugin.yaml: {error}")))?;
    let validation_error = if manifest.id != folder_id {
        Some(format!("Plugin directory must be named {}", manifest.id))
    } else {
        validate_manifest(&manifest, &root).err()
    };
    let fingerprint = plugin_fingerprint(&root, &manifest, &bytes)
        .map_err(|error| (manifest.id.clone(), error))?;
    Ok(LoadedPlugin {
        root,
        manifest,
        fingerprint,
        validation_error,
    })
}

fn validate_manifest(manifest: &PluginManifest, root: &Path) -> Result<(), String> {
    if manifest.schema_version != 2 {
        return Err("Unsupported plugin schema; expected schema_version 2".into());
    }
    if !valid_plugin_id(&manifest.id) {
        return Err(
            "Plugin id must start with local. and contain only safe identifier characters".into(),
        );
    }
    if manifest.name.trim().is_empty() || manifest.name.len() > 96 {
        return Err("Plugin name is missing or too long".into());
    }
    if manifest.version.trim().is_empty() || manifest.version.len() > 64 {
        return Err("Plugin version is missing or too long".into());
    }
    if manifest.actions.is_empty() || manifest.actions.len() > 64 {
        return Err("Plugin must define between 1 and 64 actions".into());
    }
    let mut action_ids = HashSet::new();
    for action in &manifest.actions {
        if !safe_id(&action.id) || action.id.contains('.') || !action_ids.insert(&action.id) {
            return Err(format!("Invalid or duplicate action id: {}", action.id));
        }
        if action.title.trim().is_empty() || action.title.len() > 96 {
            return Err(format!("Action {} has an invalid title", action.id));
        }
        if action.description.len() > 512 {
            return Err(format!("Action {} description is too long", action.id));
        }
        validate_command(root, &action.command)?;
        if action.activation.providers.is_empty()
            || action
                .activation
                .providers
                .iter()
                .any(|provider| ProcessProvider::from_name(provider).is_none())
        {
            return Err(format!(
                "Action {} has invalid provider activation",
                action.id
            ));
        }
        if action
            .activation
            .versions
            .iter()
            .any(|version| !valid_version_pattern(version))
        {
            return Err(format!(
                "Action {} has an invalid version activation",
                action.id
            ));
        }
        if action.timeout_seconds == 0 || action.timeout_seconds > MAX_TIMEOUT_SECONDS {
            return Err(format!(
                "Action {} timeout must be between 1 and 3600 seconds",
                action.id
            ));
        }
        if action
            .capabilities
            .iter()
            .any(|capability| !ALLOWED_CAPABILITIES.contains(&capability.as_str()))
        {
            return Err(format!(
                "Action {} requests an unknown capability",
                action.id
            ));
        }
        validate_parameter_schema(action)?;
    }
    Ok(())
}

fn validate_parameter_schema(action: &PluginAction) -> Result<(), String> {
    if action.parameters.len() > 32 {
        return Err(format!("Action {} has too many parameters", action.id));
    }
    let mut names = HashSet::new();
    for parameter in &action.parameters {
        if !safe_id(&parameter.name)
            || parameter.name.contains('.')
            || !names.insert(&parameter.name)
        {
            return Err(format!(
                "Action {} has an invalid parameter name",
                action.id
            ));
        }
        if parameter.title.trim().is_empty() || parameter.title.len() > 96 {
            return Err(format!("Parameter {} has an invalid title", parameter.name));
        }
        if parameter
            .description
            .as_ref()
            .is_some_and(|value| value.len() > 512)
            || parameter
                .placeholder
                .as_ref()
                .is_some_and(|value| value.len() > 256)
        {
            return Err(format!("Parameter {} text is too long", parameter.name));
        }
        if parameter.options.len() > 128
            || parameter.options.iter().any(|option| option.len() > 256)
        {
            return Err(format!("Parameter {} has invalid options", parameter.name));
        }
        if matches!(parameter.kind, AgentActionParameterKind::Choice)
            && parameter.options.is_empty()
        {
            return Err(format!(
                "Choice parameter {} requires options",
                parameter.name
            ));
        }
        if let Some(default) = parameter.default_value.as_deref() {
            validate_parameter_value(parameter, default)?;
        }
    }
    Ok(())
}

fn validate_command(root: &Path, command: &[String]) -> Result<(), String> {
    let Some(program) = command.first() else {
        return Err("Plugin command cannot be empty".into());
    };
    if command.len() > 32
        || command
            .iter()
            .any(|argument| argument.is_empty() || argument.len() > 4096 || argument.contains('\0'))
    {
        return Err("Plugin command contains invalid arguments".into());
    }
    if program.contains('/') {
        let path = resolve_plugin_path(root, program)?;
        if !path.is_file() {
            return Err(format!("Plugin executable does not exist: {program}"));
        }
    }
    Ok(())
}

fn resolve_plugin_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    let candidate = if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        root.join(value)
    };
    if Path::new(value).is_absolute() {
        return Ok(candidate);
    }
    let normalized = candidate
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin path {value}: {error}"))?;
    let normalized_root = root
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin directory: {error}"))?;
    if !normalized.starts_with(normalized_root) {
        return Err("Plugin command escapes its package directory".into());
    }
    Ok(normalized)
}

fn plugin_fingerprint(
    root: &Path,
    manifest: &PluginManifest,
    manifest_bytes: &[u8],
) -> Result<String, String> {
    let mut digest = Sha256::new();
    digest.update(manifest_bytes);
    let mut files = manifest
        .actions
        .iter()
        .flat_map(|action| action.command.iter())
        .filter_map(|argument| {
            if Path::new(argument).is_absolute() {
                return None;
            }
            resolve_plugin_path(root, argument)
                .ok()
                .filter(|path| path.is_file())
        })
        .collect::<Vec<_>>();
    files.sort();
    files.dedup();
    for file in files {
        let bytes = std::fs::read(&file)
            .map_err(|error| format!("Could not fingerprint {}: {error}", file.display()))?;
        digest.update(
            file.strip_prefix(root)
                .unwrap_or(&file)
                .to_string_lossy()
                .as_bytes(),
        );
        digest.update(bytes);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn load_trust_store() -> HashMap<String, String> {
    trust_store_path()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_trust_store(store: &HashMap<String, String>) -> Result<(), String> {
    let path = trust_store_path()
        .ok_or_else(|| "Could not resolve ClawTab config directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create config directory: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(store).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write plugin trust store: {error}"))?;
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("Could not activate plugin trust store: {error}"))
}

fn descriptor(
    plugin: &LoadedPlugin,
    action: PluginAction,
    provider: ProcessProvider,
    settings: &AppSettings,
    trusted: bool,
) -> AgentActionDescriptor {
    let unavailable_reason = if let Some(error) = plugin.validation_error.clone() {
        Some(format!("Invalid plugin: {error}"))
    } else if trusted {
        validate_command(&plugin.root, &action.command).err()
    } else {
        Some("Approve this plugin in ClawTab settings before running it".into())
    };
    AgentActionDescriptor {
        id: full_action_id(&plugin.manifest.id, &action.id),
        plugin_id: plugin.manifest.id.clone(),
        plugin_name: plugin.manifest.name.clone(),
        title: action.title,
        description: action.description,
        provider: provider.as_str().into(),
        parameters: action
            .parameters
            .into_iter()
            .map(|parameter| parameter_descriptor(parameter, provider, settings))
            .collect(),
        available: unavailable_reason.is_none(),
        unavailable_reason,
    }
}

fn parameter_descriptor(
    parameter: PluginParameter,
    provider: ProcessProvider,
    settings: &AppSettings,
) -> AgentActionParameter {
    let options = match parameter.kind {
        AgentActionParameterKind::Model if parameter.options.is_empty() => settings
            .enabled_models
            .get(provider.as_str())
            .cloned()
            .unwrap_or_default(),
        AgentActionParameterKind::Effort if parameter.options.is_empty() => {
            vec![
                "low".into(),
                "medium".into(),
                "high".into(),
                "xhigh".into(),
                "max".into(),
            ]
        }
        _ => parameter.options,
    };
    AgentActionParameter {
        name: parameter.name,
        title: parameter.title,
        description: parameter.description,
        kind: parameter.kind,
        required: parameter.required,
        default_value: parameter.default_value,
        placeholder: parameter.placeholder,
        options,
    }
}

fn resolve_execution_spec(
    action_id: &str,
    provider: ProcessProvider,
    version: Option<&str>,
) -> Result<ExecutionSpec, String> {
    discover_plugins()
        .into_iter()
        .filter_map(Result::ok)
        .filter(|plugin| plugin.validation_error.is_none())
        .find_map(|plugin| {
            plugin
                .manifest
                .actions
                .iter()
                .find(|action| {
                    full_action_id(&plugin.manifest.id, &action.id) == action_id
                        && activation_matches(action, provider, version)
                })
                .cloned()
                .map(|action| ExecutionSpec { plugin, action })
        })
        .ok_or_else(|| format!("Unknown or inactive plugin action: {action_id}"))
}

fn validate_parameters(
    action: &PluginAction,
    mut values: AgentActionParameters,
    provider: ProcessProvider,
    settings: &AppSettings,
) -> Result<AgentActionParameters, String> {
    for name in values.keys() {
        if !action
            .parameters
            .iter()
            .any(|parameter| parameter.name == *name)
        {
            return Err(format!("Unknown action parameter: {name}"));
        }
    }
    for parameter in &action.parameters {
        if !values.contains_key(&parameter.name) {
            if let Some(default) = parameter.default_value.clone() {
                values.insert(parameter.name.clone(), default);
            }
        }
        let Some(value) = values.get(&parameter.name) else {
            if parameter.required {
                return Err(format!("Missing {} parameter", parameter.name));
            }
            continue;
        };
        validate_parameter_value(parameter, value)?;
        let options = match parameter.kind {
            AgentActionParameterKind::Model if parameter.options.is_empty() => settings
                .enabled_models
                .get(provider.as_str())
                .cloned()
                .unwrap_or_default(),
            AgentActionParameterKind::Effort if parameter.options.is_empty() => {
                vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                    "max".into(),
                ]
            }
            _ => parameter.options.clone(),
        };
        if !options.is_empty() && !options.iter().any(|option| option == value) {
            return Err(format!("Invalid {} parameter", parameter.name));
        }
    }
    Ok(values)
}

fn validate_parameter_value(parameter: &PluginParameter, value: &str) -> Result<(), String> {
    if value.len() > 4096 || value.contains('\0') {
        return Err(format!(
            "Parameter {} is too large or invalid",
            parameter.name
        ));
    }
    if parameter.required && value.trim().is_empty() {
        return Err(format!("Parameter {} cannot be empty", parameter.name));
    }
    if matches!(parameter.kind, AgentActionParameterKind::Boolean)
        && !matches!(value, "true" | "false")
    {
        return Err(format!(
            "Parameter {} must be true or false",
            parameter.name
        ));
    }
    if matches!(parameter.kind, AgentActionParameterKind::Choice)
        && !parameter.options.iter().any(|option| option == value)
    {
        return Err(format!("Invalid {} parameter", parameter.name));
    }
    Ok(())
}

fn activation_matches(
    action: &PluginAction,
    provider: ProcessProvider,
    version: Option<&str>,
) -> bool {
    action
        .activation
        .providers
        .iter()
        .any(|candidate| candidate == provider.as_str())
        && (action.activation.versions.is_empty()
            || version.is_some_and(|value| version_matches(value, &action.activation.versions)))
}

fn version_matches(version: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        pattern
            .strip_suffix(".*")
            .is_some_and(|prefix| version == prefix || version.starts_with(&format!("{prefix}.")))
            || version == pattern
    })
}

fn valid_version_pattern(value: &str) -> bool {
    let exact = value.strip_suffix(".*").unwrap_or(value);
    !exact.is_empty()
        && exact.split('.').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
        })
        && !exact.contains('*')
}

fn full_action_id(plugin_id: &str, action_id: &str) -> String {
    format!("{plugin_id}.{action_id}")
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

fn valid_plugin_id(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("local.") else {
        return false;
    };
    !suffix.is_empty()
        && suffix.split('.').all(|part| {
            !part.is_empty()
                && part.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                })
        })
}

async fn run_plugin_process(
    spec: &ExecutionSpec,
    host: &HostRun,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let mut command = Command::new(resolve_program(&spec.plugin.root, &spec.action.command[0])?);
    command
        .args(&spec.action.command[1..])
        .current_dir(&spec.plugin.root)
        .env_clear()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    copy_safe_environment(&mut command);
    command
        .env("CLAWTAB_PLUGIN_ID", &host.plugin_id)
        .env("CLAWTAB_ACTION_ID", &host.action_id)
        .env(
            "CLAWTAB_RUN_ID",
            run_id_for_token(&host.token).unwrap_or_default(),
        )
        .env("CLAWTAB_PANE_ID", &host.pane_id)
        .env("CLAWTAB_PROVIDER", host.provider.as_str())
        .env(
            "CLAWTAB_AGENT_VERSION",
            host.provider_version.as_deref().unwrap_or(""),
        )
        .env("CLAWTAB_WORKING_DIRECTORY", &host.working_directory)
        .env(
            "CLAWTAB_PARAMETERS_JSON",
            serde_json::to_string(&host.parameters).map_err(|error| error.to_string())?,
        )
        .env("CLAWTAB_PLUGIN_TOKEN", &host.token)
        .env(
            "CLAWTAB_PLUGIN_SOCKET",
            crate::ipc::plugin_host_socket_path(),
        )
        .env("CLAWTAB_CLI", cwtctl_path());
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start plugin: {error}"))?;
    let process_id = child
        .id()
        .ok_or_else(|| "Plugin process has no PID".to_string())?;
    let stdout_task = child
        .stdout
        .take()
        .map(|stdout| tokio::spawn(read_bounded(stdout)));
    let stderr_task = child
        .stderr
        .take()
        .map(|stderr| tokio::spawn(read_bounded(stderr)));
    let timeout = Duration::from_secs(spec.action.timeout_seconds);
    let status = tokio::select! {
        result = child.wait() => result.map_err(|error| format!("Could not wait for plugin: {error}"))?,
        () = cancel.cancelled() => {
            terminate_process_group(process_id, &mut child).await;
            return Err("Plugin cancelled".into());
        }
        () = tokio::time::sleep(timeout) => {
            terminate_process_group(process_id, &mut child).await;
            return Err(format!("Plugin timed out after {} seconds", spec.action.timeout_seconds));
        }
    };
    let stdout = join_capture(stdout_task).await;
    let stderr = join_capture(stderr_task).await;
    if status.success() {
        Ok(())
    } else {
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        let detail = redact_internal_values(detail, &host.token);
        let suffix = if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        };
        Err(format!(
            "Plugin exited with {}{suffix}",
            status
                .code()
                .map_or_else(|| "a signal".into(), |code| code.to_string())
        ))
    }
}

fn redact_internal_values(value: &str, token: &str) -> String {
    value.replace(token, "[REDACTED_PLUGIN_TOKEN]").replace(
        crate::ipc::plugin_host_socket_path()
            .to_string_lossy()
            .as_ref(),
        "[REDACTED_PLUGIN_SOCKET]",
    )
}

fn run_id_for_token(token: &str) -> Option<String> {
    runtime().tokens.lock().get(token).cloned()
}

fn resolve_program(root: &Path, value: &str) -> Result<PathBuf, String> {
    if value.contains('/') {
        resolve_plugin_path(root, value)
    } else {
        Ok(PathBuf::from(value))
    }
}

fn copy_safe_environment(command: &mut Command) {
    for key in ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR"] {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }
    for (key, value) in std::env::vars().filter(|(key, _)| key.starts_with("LC_")) {
        command.env(key, value);
    }
}

fn cwtctl_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join("cwtctl")))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("cwtctl"))
}

async fn read_bounded<R: AsyncRead + Unpin>(mut reader: R) -> Vec<u8> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let count = match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        if output.len() < MAX_CAPTURE_BYTES {
            let remaining = MAX_CAPTURE_BYTES - output.len();
            output.extend_from_slice(&buffer[..count.min(remaining)]);
        }
    }
    output
}

async fn join_capture(task: Option<tokio::task::JoinHandle<Vec<u8>>>) -> String {
    match task {
        Some(task) => String::from_utf8_lossy(&task.await.unwrap_or_default()).to_string(),
        None => String::new(),
    }
}

async fn terminate_process_group(process_id: u32, child: &mut tokio::process::Child) {
    unsafe {
        libc::kill(-(process_id as i32), libc::SIGTERM);
    }
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        unsafe {
            libc::kill(-(process_id as i32), libc::SIGKILL);
        }
        let _ = child.wait().await;
    }
}

fn pane_context(pane_id: &str) -> Option<(ProcessProvider, String)> {
    let pane_pid = crate::tmux::pane_pid(pane_id).ok()?;
    let snapshot = agent_session::ProcessSnapshot::capture();
    let provider = agent_session::detect_process_provider(&pane_pid, Some(&snapshot))?;
    Some((provider, pane_pid))
}

fn pane_working_directory(pane_id: &str) -> Option<String> {
    crate::tmux::get_pane_path(pane_id).ok()
}

fn session_data(provider: ProcessProvider, pane_pid: &str) -> AgentSessionData {
    let info = agent_session::resolve_session_info_for_provider(pane_pid, Some(provider), None);
    AgentSessionData {
        provider: provider.as_str().into(),
        session_id: info.session_id,
        model: info.model_id,
        effort: info.agent_effort,
        token_count: info.token_count,
    }
}

fn provider_version(provider: ProcessProvider) -> Option<String> {
    if provider == ProcessProvider::Shell {
        return None;
    }
    let output = std::process::Command::new(provider.binary_name())
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .find(|part| {
            part.chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
        })
        .map(str::to_string)
}

fn validate_bound_pane(host: &HostRun) -> Result<(), String> {
    let (provider, pane_pid) = pane_context(&host.pane_id)
        .ok_or_else(|| "The target pane no longer hosts a supported agent".to_string())?;
    if provider != host.provider || pane_pid != host.pane_pid {
        return Err("The target pane process changed during the plugin run".into());
    }
    Ok(())
}

fn require_capability(host: &HostRun, capability: &str) -> Result<(), String> {
    if host.capabilities.contains(capability) {
        Ok(())
    } else {
        Err(format!(
            "Plugin did not declare required capability: {capability}"
        ))
    }
}

fn validate_progress(message: &str, percent: u8) -> Result<(), String> {
    if message.trim().is_empty() || message.len() > 160 || message.contains(['\n', '\r']) {
        return Err("Progress message is invalid".into());
    }
    if percent > 99 {
        return Err("Plugin progress percent must be between 0 and 99".into());
    }
    Ok(())
}

fn validate_input(value: &str) -> Result<(), String> {
    if value.len() > 16 * 1024 || value.contains('\0') {
        Err("Pane input is too large or invalid".into())
    } else {
        Ok(())
    }
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 32
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        Err("Pane key is invalid".into())
    } else {
        Ok(())
    }
}

fn validate_model_value(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        Err("Model value is invalid".into())
    } else {
        Ok(())
    }
}

fn validate_effort(value: &str) -> Result<(), String> {
    if matches!(value, "low" | "medium" | "high" | "xhigh" | "max") {
        Ok(())
    } else {
        Err("Reasoning effort is invalid".into())
    }
}

fn agent_state(host: &HostRun) -> Result<PluginAgentState, String> {
    let session = session_data(host.provider, &host.pane_pid);
    if host.provider != ProcessProvider::Codex {
        return Ok(PluginAgentState {
            provider: host.provider.as_str().into(),
            idle: true,
            busy: false,
            model: session.model,
            effort: session.effort,
            draft_present: false,
        });
    }
    let state = codex_screen_state(&host.pane_id)?;
    Ok(PluginAgentState {
        provider: host.provider.as_str().into(),
        idle: state.idle,
        busy: state.busy,
        model: session.model,
        effort: session.effort,
        draft_present: state
            .draft
            .as_deref()
            .is_some_and(|draft| !draft.is_empty()),
    })
}

fn submit_text(pane_id: &str, provider: ProcessProvider, text: &str) -> Result<(), String> {
    if provider == ProcessProvider::Codex && codex_vim_normal_mode(&capture_plain(pane_id)?) {
        crate::tmux::send_key_to_pane(pane_id, "i")?;
        std::thread::sleep(Duration::from_millis(100));
    }
    crate::tmux::send_literal_to_pane(pane_id, text)?;
    std::thread::sleep(Duration::from_millis(100));
    crate::tmux::send_key_to_pane(pane_id, "Enter")
}

async fn wait_for_state(
    host: &HostRun,
    target: &str,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<(), String> {
    if !matches!(target, "idle" | "busy") {
        return Err("State must be idle or busy".into());
    }
    let started = Instant::now();
    loop {
        if cancel.is_cancelled() {
            return Err("Plugin cancelled".into());
        }
        validate_bound_pane(host)?;
        let state = agent_state(host)?;
        if (target == "idle" && state.idle) || (target == "busy" && state.busy) {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err(format!("Timed out waiting for agent state {target}"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn select_model(
    host: &HostRun,
    model: &str,
    effort: Option<&str>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    if host.provider != ProcessProvider::Codex {
        return Err("Model selection is currently implemented only for Codex".into());
    }
    if host.baseline.model.is_none() || effort.is_some() && host.baseline.effort.is_none() {
        return Err("Codex baseline model and effort could not be determined safely".into());
    }
    let state = codex_screen_state(&host.pane_id)?;
    if !state.idle
        || state
            .draft
            .as_deref()
            .is_some_and(|draft| !draft.is_empty())
    {
        return Err("Codex must be idle with an empty composer before changing model".into());
    }
    submit_text(&host.pane_id, host.provider, "/model")?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    choose_codex_option(&host.pane_id, model, cancel).await?;
    if let Some(effort) = effort {
        tokio::time::sleep(Duration::from_millis(150)).await;
        if capture_plain(&host.pane_id)?.contains("Select Reasoning Level") {
            choose_codex_option(&host.pane_id, effort_label(effort), cancel).await?;
        }
    }
    wait_for_model(host, model, effort, cancel).await
}

async fn choose_codex_option(
    pane_id: &str,
    target: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    for _ in 0..32 {
        if cancel.is_cancelled() {
            return Err("Plugin cancelled".into());
        }
        let screen = capture_plain(pane_id)?;
        let target_lower = target.to_ascii_lowercase();
        if screen
            .lines()
            .any(|line| selected_option_matches(line, &target_lower))
        {
            crate::tmux::send_key_to_pane(pane_id, "Enter")?;
            return Ok(());
        }
        crate::tmux::send_key_to_pane(pane_id, "Down")?;
        tokio::time::sleep(Duration::from_millis(45)).await;
    }
    Err("Could not safely select the requested Codex option".into())
}

fn selected_option_matches(line: &str, target: &str) -> bool {
    let trimmed = line.trim_start();
    let Some(marker) = ["›", ">"]
        .into_iter()
        .find(|marker| trimmed.starts_with(marker))
    else {
        return false;
    };
    let mut option = trimmed[marker.len()..].trim_start();
    if let Some((ordinal, rest)) = option.split_once('.') {
        if !ordinal.is_empty() && ordinal.chars().all(|character| character.is_ascii_digit()) {
            option = rest.trim_start();
        }
    }
    let option_lower = option.to_ascii_lowercase();
    option_lower.strip_prefix(target).is_some_and(|remainder| {
        remainder.is_empty()
            || remainder.starts_with(char::is_whitespace)
            || remainder.starts_with('(')
            || remainder.starts_with('…')
    })
}

async fn wait_for_model(
    host: &HostRun,
    model: &str,
    effort: Option<&str>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < MODEL_VERIFY_TIMEOUT {
        if cancel.is_cancelled() {
            return Err("Plugin cancelled".into());
        }
        let session = session_data(host.provider, &host.pane_pid);
        if session.model.as_deref() == Some(model)
            && effort.is_none_or(|expected| session.effort.as_deref() == Some(expected))
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("Codex did not confirm the requested model and effort".into())
}

fn effort_label(effort: &str) -> &str {
    match effort {
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra high",
        "max" => "More reasoning",
        value => value,
    }
}

async fn restore_baseline(host: &HostRun, cancel: &CancellationToken) -> Result<(), String> {
    let Some(model) = host.baseline.model.as_deref() else {
        return Ok(());
    };
    select_model(host, model, host.baseline.effort.as_deref(), cancel).await
}

fn stash_draft(host: &HostRun) -> Result<Option<String>, String> {
    if host.provider != ProcessProvider::Codex {
        return Ok(None);
    }
    let state = codex_screen_state(&host.pane_id)?;
    if !state.idle {
        return Err("Codex must be idle before stashing its draft".into());
    }
    let draft = state.draft.filter(|draft| !draft.is_empty());
    if draft.is_some() {
        crate::tmux::send_key_to_pane(&host.pane_id, "C-u")?;
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(draft)
}

fn restore_stashed_draft(host: &HostRun) -> Result<(), String> {
    let Some(draft) = host.stashed_draft.as_deref() else {
        return Ok(());
    };
    let state = codex_screen_state(&host.pane_id)?;
    if !state.idle
        || state
            .draft
            .as_deref()
            .is_some_and(|value| !value.is_empty())
    {
        return Err("Codex composer is not empty; draft was not restored".into());
    }
    crate::tmux::send_literal_to_pane(&host.pane_id, draft)
}

async fn recover_host_state(host: &HostRun) -> Result<(), String> {
    validate_bound_pane(host)?;
    let cancel = CancellationToken::new();
    if host.model_changed {
        restore_baseline(host, &cancel).await?;
    }
    restore_stashed_draft(host)
}

struct CodexScreenState {
    idle: bool,
    busy: bool,
    draft: Option<String>,
}

fn codex_screen_state(pane_id: &str) -> Result<CodexScreenState, String> {
    let screen = capture_plain(pane_id)?;
    let in_dialog = screen.contains("Select model")
        || screen.contains("Select Reasoning Level")
        || screen
            .to_ascii_lowercase()
            .contains("press enter to confirm");
    let busy = screen.to_ascii_lowercase().contains("esc to interrupt");
    let draft = screen.lines().rev().find_map(|line| {
        line.trim_start()
            .strip_prefix('›')
            .map(|value| value.trim().to_string())
    });
    let draft = draft.map(|value| {
        if value == "Ask Codex to do anything" {
            String::new()
        } else {
            value
        }
    });
    Ok(CodexScreenState {
        idle: draft.is_some() && !in_dialog && !busy,
        busy,
        draft,
    })
}

fn codex_vim_normal_mode(screen: &str) -> bool {
    screen.lines().any(|line| line.contains("Vim: Normal"))
}

fn capture_plain(pane_id: &str) -> Result<String, String> {
    let (captured, _) = crate::tmux::capture_pane_visible(pane_id)?;
    Ok(strip_ansi(&captured))
}

fn strip_ansi(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' && characters.peek() == Some(&'[') {
            characters.next();
            for code in characters.by_ref() {
                if ('@'..='~').contains(&code) {
                    break;
                }
            }
        } else if character != '\r' {
            result.push(character);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{
        load_plugin, redact_internal_values, selected_option_matches, strip_ansi, valid_plugin_id,
        valid_version_pattern, version_matches,
    };

    #[test]
    fn version_patterns_support_exact_and_series_matches() {
        assert!(version_matches("0.151.2", &["0.151.*".into()]));
        assert!(version_matches("0.151.2", &["0.151.2".into()]));
        assert!(!version_matches("0.152.0", &["0.151.*".into()]));
    }

    #[test]
    fn version_patterns_reject_embedded_wildcards_and_empty_parts() {
        assert!(valid_version_pattern("0.151.*"));
        assert!(valid_version_pattern("0.151.2-beta"));
        assert!(!valid_version_pattern("0.*.2"));
        assert!(!valid_version_pattern("0..151"));
    }

    #[test]
    fn plugin_ids_require_nonempty_local_namespace_segments() {
        assert!(valid_plugin_id("local.example"));
        assert!(valid_plugin_id("local.my-plugin.actions"));
        assert!(!valid_plugin_id("example"));
        assert!(!valid_plugin_id("local."));
        assert!(!valid_plugin_id("local.example..actions"));
    }

    #[test]
    fn local_manifest_loads_and_fingerprint_changes_with_executable() {
        let temporary = tempfile::tempdir().expect("temporary directory should be created");
        let root = temporary.path().join("local.example");
        fs::create_dir(&root).expect("plugin directory should be created");
        fs::write(root.join("run.sh"), "#!/bin/sh\nexit 0\n")
            .expect("plugin executable should be written");
        fs::write(
            root.join("plugin.yaml"),
            r#"schema_version: 2
id: local.example
name: Example
version: 1.0.0
actions:
  - id: summarize
    title: Summarize
    command: ["./run.sh"]
    activation:
      providers: [codex]
"#,
        )
        .expect("manifest should be written");

        let first = load_plugin(root.clone()).expect("valid plugin should load");
        fs::write(root.join("run.sh"), "#!/bin/sh\nexit 1\n")
            .expect("plugin executable should be updated");
        let second = load_plugin(root).expect("updated plugin should load");

        assert_ne!(first.fingerprint, second.fingerprint);
    }

    #[test]
    fn parsed_invalid_manifest_keeps_metadata_for_review() {
        let temporary = tempfile::tempdir().expect("temporary directory should be created");
        let root = temporary.path().join("wrong-directory");
        fs::create_dir(&root).expect("plugin directory should be created");
        fs::write(
            root.join("plugin.yaml"),
            r#"schema_version: 2
id: local.example
name: Example
version: 1.0.0
actions:
  - id: summarize
    title: Summarize
    command: ["sh"]
    activation:
      providers: [codex]
"#,
        )
        .expect("manifest should be written");

        let plugin = load_plugin(root).expect("parsed plugin should remain discoverable");

        assert_eq!(plugin.manifest.name, "Example");
        assert!(plugin.validation_error.is_some());
    }

    #[test]
    fn selected_option_requires_a_selected_marker() {
        assert!(selected_option_matches("› 1. gpt-5.6-luna", "gpt-5.6-luna"));
        assert!(!selected_option_matches(
            "  1. gpt-5.6-luna",
            "gpt-5.6-luna"
        ));
    }

    #[test]
    fn terminal_escape_sequences_are_removed() {
        assert_eq!(strip_ansi("\u{1b}[31mhello\u{1b}[0m\r"), "hello");
    }

    #[test]
    fn internal_plugin_credentials_are_redacted_from_failures() {
        let output = redact_internal_values(
            "token=secret-token socket=/tmp/clawtab/plugin-host.sock",
            "secret-token",
        );
        assert!(!output.contains("secret-token"));
        assert!(!output.contains("/tmp/clawtab/plugin-host.sock"));
    }
}
