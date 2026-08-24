use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use clawtab_protocol::{
    AgentActionDescriptor, AgentActionParameter, AgentActionParameterKind, AgentActionParameters,
    AgentActionRun, AgentActionRunState, AgentSessionData,
};
use parking_lot::Mutex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::agent_session::{self, ProcessProvider};
use crate::config::settings::AppSettings;

const RUN_RETENTION: Duration = Duration::from_secs(15 * 60);
const COMPACT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MODEL_VERIFY_TIMEOUT: Duration = Duration::from_secs(12);
const CATALOG_REFRESH_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const CATALOG_BASE_URL: &str = "https://cdn.clawtab.cc/agent-plugins/v1";
// Dedicated agent-catalog verification key. It is intentionally independent
// of the desktop updater key so either trust root can be rotated separately.
const CATALOG_PUBLIC_KEY: [u8; 32] = [
    0x40, 0xca, 0x3a, 0xe3, 0xbe, 0x47, 0x40, 0x2f, 0x4d, 0x31, 0x0d, 0x9e, 0xff, 0x69, 0x91, 0x7d,
    0x20, 0xd0, 0x87, 0xd0, 0x64, 0xed, 0x39, 0x55, 0xd4, 0x0f, 0x80, 0x6d, 0x2d, 0x49, 0xc4, 0x42,
];

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ActionKind {
    CheapCompact,
    SetModel,
    NextModel,
    PreviousModel,
    SessionInfo,
}

#[derive(Debug, Clone, Deserialize)]
struct CatalogAction {
    id: String,
    title: String,
    description: String,
    kind: ActionKind,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginManifest {
    schema_version: u32,
    namespace: String,
    provider: String,
    compatible_versions: Vec<String>,
    #[serde(default)]
    ui: ProviderUiProfile,
    actions: Vec<CatalogAction>,
}

#[derive(Debug, Clone, Deserialize)]
struct ProviderUiProfile {
    composer_marker: String,
    #[serde(default)]
    composer_placeholder: Option<String>,
    model_dialog_marker: String,
    effort_dialog_marker: String,
    effort_labels: HashMap<String, String>,
    busy_marker: String,
    selected_markers: Vec<String>,
    model_command: String,
    compact_command: String,
    compact_confirmation_marker: Option<String>,
    stash_key: String,
    cancel_key: String,
    next_key: String,
    submit_key: String,
    history_key: String,
}

impl Default for ProviderUiProfile {
    fn default() -> Self {
        Self {
            composer_marker: "›".into(),
            composer_placeholder: Some("Ask Codex to do anything".into()),
            model_dialog_marker: "Select model".into(),
            effort_dialog_marker: "Select Reasoning Level".into(),
            effort_labels: HashMap::from([
                ("low".into(), "Low".into()),
                ("medium".into(), "Medium".into()),
                ("high".into(), "High".into()),
                ("xhigh".into(), "Extra high".into()),
                ("max".into(), "More reasoning".into()),
            ]),
            busy_marker: "esc to interrupt".into(),
            selected_markers: vec!["›".into(), ">".into()],
            model_command: "/model".into(),
            compact_command: "/compact".into(),
            compact_confirmation_marker: None,
            // Ctrl-U clears the composer without invoking Codex's interrupt/exit behavior.
            stash_key: "C-u".into(),
            cancel_key: "Escape".into(),
            next_key: "Down".into(),
            submit_key: "Enter".into(),
            history_key: "Up".into(),
        }
    }
}

#[derive(Clone)]
struct ExecutionSpec {
    kind: ActionKind,
    ui: ProviderUiProfile,
}

#[derive(Debug, Clone, Deserialize)]
struct SignedCatalogIndex {
    schema_version: u32,
    plugins: Vec<SignedCatalogEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct SignedCatalogEntry {
    file: String,
    sha256: String,
}

#[derive(Clone)]
struct StoredRun {
    run: AgentActionRun,
    updated_at: Instant,
    cancel: CancellationToken,
}

#[derive(Default)]
pub struct AgentPluginRuntime {
    runs: Mutex<HashMap<String, StoredRun>>,
    active_panes: Mutex<HashSet<String>>,
    observer: Mutex<Option<Arc<dyn Fn(AgentActionRun) + Send + Sync>>>,
}

pub fn runtime() -> &'static Arc<AgentPluginRuntime> {
    static RUNTIME: OnceLock<Arc<AgentPluginRuntime>> = OnceLock::new();
    RUNTIME.get_or_init(|| Arc::new(AgentPluginRuntime::default()))
}

pub fn observe_detected_provider(provider: &str, settings: &AppSettings) {
    if provider == "codex" && settings.agent_plugins.catalog_updates_enabled {
        maybe_schedule_catalog_refresh();
    }
}

impl AgentPluginRuntime {
    pub fn set_observer(&self, observer: Arc<dyn Fn(AgentActionRun) + Send + Sync>) {
        *self.observer.lock() = Some(observer);
    }

    pub fn list_actions(
        &self,
        pane_id: &str,
        settings: &AppSettings,
    ) -> (Vec<AgentActionDescriptor>, Option<AgentSessionData>) {
        let context = pane_context(pane_id);
        let provider = context.as_ref().map(|value| value.0);
        let version = provider.and_then(provider_version);
        let session = context
            .as_ref()
            .map(|(provider, pane_pid)| session_data(*provider, pane_pid));
        if provider.is_some() && settings.agent_plugins.catalog_updates_enabled {
            maybe_schedule_catalog_refresh();
        }
        let mut manifests = catalog_manifests(settings);
        manifests.sort_by_key(|manifest| {
            !version
                .as_deref()
                .is_some_and(|value| version_matches(value, &manifest.compatible_versions))
        });
        let enabled_models = settings
            .enabled_models
            .get("codex")
            .cloned()
            .unwrap_or_default();
        let mut descriptors = Vec::new();
        let mut seen_action_ids = HashSet::new();
        for manifest in manifests {
            let manifest_error = validate_manifest(&manifest).err();
            let compatible = version
                .as_deref()
                .is_some_and(|value| version_matches(value, &manifest.compatible_versions));
            for action in manifest.actions {
                if !seen_action_ids.insert(action.id.clone()) {
                    continue;
                }
                let mut unavailable_reason = manifest_error.clone();
                if unavailable_reason.is_none()
                    && provider.map(ProcessProvider::as_str) != Some(manifest.provider.as_str())
                {
                    unavailable_reason =
                        Some("This action does not support the detected agent".into());
                }
                if unavailable_reason.is_none() && !compatible {
                    unavailable_reason = Some(match version.as_deref() {
                        Some(value) => {
                            format!("Codex {value} is not covered by this action catalog")
                        }
                        None => "Could not determine the agent version".to_string(),
                    });
                }
                if unavailable_reason.is_none()
                    && matches!(action.kind, ActionKind::CheapCompact)
                    && settings
                        .agent_plugins
                        .compact_presets
                        .get("codex")
                        .is_none_or(|preset| !enabled_models.contains(&preset.model))
                {
                    unavailable_reason = Some("Enable the configured compact model first".into());
                }
                if unavailable_reason.is_none()
                    && matches!(
                        action.kind,
                        ActionKind::NextModel | ActionKind::PreviousModel
                    )
                    && enabled_models.len() < 2
                {
                    unavailable_reason = Some("Enable at least two Codex models first".into());
                }
                let parameters = if matches!(action.kind, ActionKind::SetModel) {
                    vec![
                        AgentActionParameter {
                            name: "model".into(),
                            title: "Model".into(),
                            kind: AgentActionParameterKind::Model,
                            required: true,
                            options: enabled_models.clone(),
                        },
                        AgentActionParameter {
                            name: "effort".into(),
                            title: "Reasoning effort".into(),
                            kind: AgentActionParameterKind::Effort,
                            required: false,
                            options: vec![
                                "low".into(),
                                "medium".into(),
                                "high".into(),
                                "xhigh".into(),
                                "max".into(),
                            ],
                        },
                    ]
                } else {
                    Vec::new()
                };
                descriptors.push(AgentActionDescriptor {
                    id: action.id,
                    title: action.title,
                    description: action.description,
                    provider: manifest.provider.clone(),
                    parameters,
                    available: unavailable_reason.is_none(),
                    unavailable_reason,
                });
            }
        }
        (descriptors, session)
    }

    pub fn start(
        self: &Arc<Self>,
        pane_id: String,
        action_id: String,
        parameters: AgentActionParameters,
        settings: AppSettings,
    ) -> Result<AgentActionRun, String> {
        let (actions, _) = self.list_actions(&pane_id, &settings);
        let action = actions
            .into_iter()
            .find(|candidate| candidate.id == action_id)
            .ok_or_else(|| format!("Unknown agent action: {action_id}"))?;
        if !action.available {
            return Err(action
                .unavailable_reason
                .unwrap_or_else(|| "Action is unavailable".to_string()));
        }
        let version = provider_version(ProcessProvider::Codex)
            .ok_or_else(|| "Could not determine the Codex version".to_string())?;
        let spec = resolve_execution_spec(&action_id, &version, &settings)
            .ok_or_else(|| "The action has no validated execution profile".to_string())?;
        {
            let mut panes = self.active_panes.lock();
            if !panes.insert(pane_id.clone()) {
                return Err("Another agent action is already running in this pane".to_string());
            }
        }
        self.prune_runs();
        let run_id = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let run = AgentActionRun {
            run_id: run_id.clone(),
            pane_id: pane_id.clone(),
            action_id: action_id.clone(),
            state: AgentActionRunState::Queued,
            progress: "Queued".to_string(),
            progress_percent: 0,
            result: None,
            error: None,
        };
        self.runs.lock().insert(
            run_id.clone(),
            StoredRun {
                run: run.clone(),
                updated_at: Instant::now(),
                cancel: cancel.clone(),
            },
        );
        self.notify(run.clone());
        let runtime = Arc::clone(self);
        tokio::spawn(async move {
            runtime
                .execute(run_id, pane_id, parameters, settings, spec, cancel)
                .await;
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

    async fn execute(
        &self,
        run_id: String,
        pane_id: String,
        parameters: AgentActionParameters,
        settings: AppSettings,
        spec: ExecutionSpec,
        cancel: CancellationToken,
    ) {
        self.update(
            &run_id,
            AgentActionRunState::Running,
            "Checking agent state",
            5,
            None,
            None,
        );
        let result = execute_codex_action(
            self,
            &run_id,
            &pane_id,
            &parameters,
            &settings,
            &spec,
            &cancel,
        )
        .await;
        match result {
            Ok(value) if cancel.is_cancelled() => self.update(
                &run_id,
                AgentActionRunState::Cancelled,
                "Cancelled",
                100,
                Some(value),
                None,
            ),
            Ok(value) => self.update(
                &run_id,
                AgentActionRunState::Succeeded,
                "Complete",
                100,
                Some(value),
                None,
            ),
            Err(error) => {
                let needs_attention = error.starts_with("RECOVERY_FAILED:");
                let message = error
                    .trim_start_matches("RECOVERY_FAILED:")
                    .trim()
                    .to_string();
                self.update(
                    &run_id,
                    if needs_attention {
                        AgentActionRunState::NeedsUserAttention
                    } else if cancel.is_cancelled() {
                        AgentActionRunState::Cancelled
                    } else {
                        AgentActionRunState::Failed
                    },
                    if needs_attention {
                        "Needs attention"
                    } else {
                        "Stopped"
                    },
                    100,
                    None,
                    Some(message),
                );
            }
        }
        self.active_panes.lock().remove(&pane_id);
    }

    fn update(
        &self,
        run_id: &str,
        state: AgentActionRunState,
        progress: &str,
        progress_percent: u8,
        result: Option<serde_json::Value>,
        error: Option<String>,
    ) {
        let updated = if let Some(stored) = self.runs.lock().get_mut(run_id) {
            stored.run.state = state;
            stored.run.progress = progress.to_string();
            stored.run.progress_percent = progress_percent;
            stored.run.result = result;
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

    fn notify(&self, run: AgentActionRun) {
        let observer = self.observer.lock().clone();
        if let Some(observer) = observer {
            observer(run);
        }
    }

    fn prune_runs(&self) {
        self.runs.lock().retain(|_, stored| {
            !stored.run.state.is_terminal() || stored.updated_at.elapsed() < RUN_RETENTION
        });
    }
}

async fn execute_codex_action(
    runtime: &AgentPluginRuntime,
    run_id: &str,
    pane_id: &str,
    parameters: &AgentActionParameters,
    settings: &AppSettings,
    spec: &ExecutionSpec,
    cancel: &CancellationToken,
) -> Result<serde_json::Value, String> {
    let (_, pane_pid) =
        pane_context(pane_id).ok_or("No supported agent is running in this pane")?;
    if matches!(spec.kind, ActionKind::SessionInfo) {
        return serde_json::to_value(session_data(ProcessProvider::Codex, &pane_pid))
            .map_err(|error| error.to_string());
    }
    let initial = agent_session::resolve_session_info_for_provider(
        &pane_pid,
        Some(ProcessProvider::Codex),
        None,
    );
    let screen = private_screen_state(pane_id, &spec.ui)?;
    if !screen.idle {
        return Err("Codex must be idle at its normal composer before running this action".into());
    }
    let saved_draft = screen.draft.clone().filter(|draft| !draft.is_empty());
    if saved_draft.is_some() {
        crate::tmux::send_key_to_pane(pane_id, &spec.ui.stash_key)?;
        wait_until_empty_composer(pane_id, &spec.ui, cancel, Duration::from_secs(2)).await?;
    }
    if cancel.is_cancelled() {
        return Err("Action cancelled".to_string());
    }
    let attempt: Result<serde_json::Value, String> = async {
        if matches!(spec.kind, ActionKind::CheapCompact) {
            let preset = settings
                .agent_plugins
                .compact_presets
                .get("codex")
                .cloned()
                .ok_or("No Codex compact preset is configured")?;
            runtime.update(run_id, AgentActionRunState::Running, "Switching to compact model", 15, None, None);
            select_model(
                pane_id,
                &pane_pid,
                &preset.model,
                Some(&preset.effort),
                &spec.ui,
                cancel,
            )
            .await?;
            runtime.update(run_id, AgentActionRunState::Running, "Compacting context", 40, None, None);
            ensure_empty_composer(pane_id, &spec.ui)?;
            submit_command(pane_id, &spec.ui.compact_command, &spec.ui)?;
            confirm_compact_if_requested(pane_id, &spec.ui).await?;
            wait_until_idle(pane_id, &spec.ui, cancel, COMPACT_TIMEOUT).await?;
            runtime.update(run_id, AgentActionRunState::Running, "Restoring model", 80, None, None);
            let previous_model = initial.model_id.as_deref().ok_or("Could not read the current Codex model")?;
            select_model(
                pane_id,
                &pane_pid,
                previous_model,
                initial.agent_effort.as_deref(),
                &spec.ui,
                cancel,
            )
            .await?;
            Ok(serde_json::json!({"compacted": true, "model": previous_model, "effort": initial.agent_effort}))
        } else {
            let enabled = settings.enabled_models.get("codex").cloned().unwrap_or_default();
            let current = initial.model_id.as_deref().ok_or("Could not read the current Codex model")?;
            let (model, effort) = if matches!(spec.kind, ActionKind::SetModel) {
                let model = parameters.get("model").ok_or("Missing model parameter")?.clone();
                if !enabled.contains(&model) {
                    return Err("The requested model is not enabled in ClawTab settings".into());
                }
                (model, parameters.get("effort").cloned())
            } else {
                let index = enabled.iter().position(|model| model == current).unwrap_or(0);
                let next = if matches!(spec.kind, ActionKind::PreviousModel) {
                    (index + enabled.len() - 1) % enabled.len()
                } else {
                    (index + 1) % enabled.len()
                };
                (enabled[next].clone(), initial.agent_effort.clone())
            };
            runtime.update(run_id, AgentActionRunState::Running, "Changing model", 35, None, None);
            select_model(
                pane_id,
                &pane_pid,
                &model,
                effort.as_deref(),
                &spec.ui,
                cancel,
            )
            .await?;
            Ok(serde_json::json!({"model": model, "effort": effort}))
        }
    }
    .await;

    match attempt {
        Ok(outcome) => {
            if let Some(draft) = saved_draft.as_deref() {
                runtime.update(
                    run_id,
                    AgentActionRunState::Running,
                    "Restoring draft",
                    95,
                    None,
                    None,
                );
                restore_draft(pane_id, draft, &spec.ui).map_err(|error| {
                    format!("RECOVERY_FAILED: The action completed, but the saved draft could not be restored: {error}")
                })?;
            }
            Ok(outcome)
        }
        Err(action_error) => {
            runtime.update(
                run_id,
                AgentActionRunState::Running,
                "Recovering previous state",
                90,
                None,
                None,
            );
            let recovery = recover_previous_state(
                pane_id,
                &pane_pid,
                initial.model_id.as_deref(),
                initial.agent_effort.as_deref(),
                saved_draft.as_deref(),
                &spec.ui,
            )
            .await;
            match recovery {
                Ok(()) => Err(action_error),
                Err(recovery_error) => Err(format!(
                    "RECOVERY_FAILED: {action_error}. Automatic recovery also failed: {recovery_error}"
                )),
            }
        }
    }
}

async fn recover_previous_state(
    pane_id: &str,
    pane_pid: &str,
    model: Option<&str>,
    effort: Option<&str>,
    draft: Option<&str>,
    ui: &ProviderUiProfile,
) -> Result<(), String> {
    let mut screen = private_screen_state(pane_id, ui)?;
    if !screen.idle {
        let _ = crate::tmux::send_key_to_pane(pane_id, &ui.cancel_key);
        tokio::time::sleep(Duration::from_millis(150)).await;
        screen = private_screen_state(pane_id, ui)?;
    }
    if !screen.idle || screen.has_draft {
        return Err("Codex is not at an idle composer".to_string());
    }
    if let Some(model) = model {
        let current = agent_session::resolve_session_info_for_provider(
            pane_pid,
            Some(ProcessProvider::Codex),
            None,
        );
        if current.model_id.as_deref() != Some(model)
            || effort.is_some_and(|value| current.agent_effort.as_deref() != Some(value))
        {
            select_model(
                pane_id,
                pane_pid,
                model,
                effort,
                ui,
                &CancellationToken::new(),
            )
            .await?;
        }
    }
    if let Some(draft) = draft {
        restore_draft(pane_id, draft, ui)?;
    }
    Ok(())
}

fn pane_context(pane_id: &str) -> Option<(ProcessProvider, String)> {
    let pane_pid = crate::tmux::pane_pid(pane_id).ok()?;
    let snapshot = agent_session::ProcessSnapshot::capture();
    let provider = agent_session::detect_process_provider(&pane_pid, Some(&snapshot))?;
    Some((provider, pane_pid))
}

fn session_data(provider: ProcessProvider, pane_pid: &str) -> AgentSessionData {
    let info = agent_session::resolve_session_info_for_provider(pane_pid, Some(provider), None);
    AgentSessionData {
        provider: provider.as_str().to_string(),
        session_id: info.session_id,
        model: info.model_id,
        effort: info.agent_effort,
        token_count: info.token_count,
    }
}

fn provider_version(provider: ProcessProvider) -> Option<String> {
    let output = std::process::Command::new(provider.binary_name())
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .find(|part| part.chars().next().is_some_and(|ch| ch.is_ascii_digit()))
        .map(|value| value.to_string())
}

fn bundled_manifest() -> PluginManifest {
    serde_json::from_str(include_str!("../../../agent-plugins/v1/codex-0.149.json")).unwrap_or_else(
        |_| PluginManifest {
            schema_version: 0,
            namespace: "invalid".into(),
            provider: "invalid".into(),
            compatible_versions: Vec::new(),
            ui: ProviderUiProfile::default(),
            actions: Vec::new(),
        },
    )
}

fn catalog_manifests(settings: &AppSettings) -> Vec<PluginManifest> {
    let mut manifests = load_verified_cached_manifests();
    manifests.push(bundled_manifest());
    if settings.agent_plugins.local_plugins_enabled {
        manifests.extend(load_local_manifests());
    }
    manifests
}

fn resolve_execution_spec(
    action_id: &str,
    version: &str,
    settings: &AppSettings,
) -> Option<ExecutionSpec> {
    for manifest in catalog_manifests(settings) {
        if validate_manifest(&manifest).is_err()
            || !version_matches(version, &manifest.compatible_versions)
        {
            continue;
        }
        if let Some(action) = manifest
            .actions
            .iter()
            .find(|action| action.id == action_id)
        {
            return Some(ExecutionSpec {
                kind: action.kind,
                ui: manifest.ui,
            });
        }
    }
    None
}

fn catalog_cache_dir() -> Option<PathBuf> {
    crate::config::config_dir().map(|path| path.join("agent-plugin-catalog-v1"))
}

fn maybe_schedule_catalog_refresh() {
    static LAST_ATTEMPT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    let attempts = LAST_ATTEMPT.get_or_init(|| Mutex::new(None));
    {
        let mut last_attempt = attempts.lock();
        if last_attempt.is_some_and(|attempt| attempt.elapsed() < CATALOG_REFRESH_INTERVAL) {
            return;
        }
        *last_attempt = Some(Instant::now());
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    handle.spawn(async {
        if let Err(error) = refresh_catalog().await {
            log::warn!("Agent plugin catalog refresh failed: {}", error);
        }
    });
}

async fn refresh_catalog() -> Result<(), String> {
    let cache_dir = catalog_cache_dir().ok_or("Could not determine the catalog cache directory")?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Could not create the catalog cache: {error}"))?;
    let etag = std::fs::read_to_string(cache_dir.join("etag")).ok();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not initialize catalog HTTP client: {error}"))?;
    let mut request = client.get(format!("{CATALOG_BASE_URL}/index.json"));
    if let Some(etag) = etag.as_deref() {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Index request failed: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(());
    }
    if !response.status().is_success() {
        return Err(format!("Index request returned {}", response.status()));
    }
    let response_etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let index_bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read the catalog index: {error}"))?;
    let signature_text = client
        .get(format!("{CATALOG_BASE_URL}/index.json.sig"))
        .send()
        .await
        .map_err(|error| format!("Signature request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Signature request failed: {error}"))?
        .text()
        .await
        .map_err(|error| format!("Could not read the catalog signature: {error}"))?;
    verify_catalog_signature(&index_bytes, signature_text.trim())?;
    let index: SignedCatalogIndex = serde_json::from_slice(&index_bytes)
        .map_err(|error| format!("Catalog index is invalid: {error}"))?;
    validate_catalog_index(&index)?;

    for entry in &index.plugins {
        let bytes = client
            .get(format!("{CATALOG_BASE_URL}/{}", entry.file))
            .send()
            .await
            .map_err(|error| format!("Plugin request failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("Plugin request failed: {error}"))?
            .bytes()
            .await
            .map_err(|error| format!("Could not read a plugin manifest: {error}"))?;
        if sha256_hex(&bytes) != entry.sha256.to_ascii_lowercase() {
            return Err(format!("Hash verification failed for {}", entry.file));
        }
        let manifest: PluginManifest = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Plugin manifest is invalid: {error}"))?;
        validate_manifest(&manifest)?;
        atomic_write(&cache_dir.join(&entry.file), &bytes)?;
    }
    atomic_write(&cache_dir.join("index.json"), &index_bytes)?;
    atomic_write(
        &cache_dir.join("index.json.sig"),
        signature_text.trim().as_bytes(),
    )?;
    if let Some(etag) = response_etag {
        atomic_write(&cache_dir.join("etag"), etag.as_bytes())?;
    }
    Ok(())
}

fn validate_catalog_index(index: &SignedCatalogIndex) -> Result<(), String> {
    if index.schema_version != 1 || index.plugins.len() > 32 {
        return Err("Unsupported catalog index".to_string());
    }
    if index.plugins.iter().any(|entry| {
        entry.file.is_empty()
            || entry.file.len() > 128
            || !entry.file.ends_with(".json")
            || !entry
                .file
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
            || entry.sha256.len() != 64
            || !entry.sha256.chars().all(|ch| ch.is_ascii_hexdigit())
    }) {
        return Err("Catalog index contains an unsafe entry".to_string());
    }
    Ok(())
}

fn load_verified_cached_manifests() -> Vec<PluginManifest> {
    let Some(cache_dir) = catalog_cache_dir() else {
        return Vec::new();
    };
    let Ok(index_bytes) = std::fs::read(cache_dir.join("index.json")) else {
        return Vec::new();
    };
    let Ok(signature) = std::fs::read_to_string(cache_dir.join("index.json.sig")) else {
        return Vec::new();
    };
    if verify_catalog_signature(&index_bytes, signature.trim()).is_err() {
        return Vec::new();
    }
    let Ok(index) = serde_json::from_slice::<SignedCatalogIndex>(&index_bytes) else {
        return Vec::new();
    };
    if validate_catalog_index(&index).is_err() {
        return Vec::new();
    }
    index
        .plugins
        .into_iter()
        .filter_map(|entry| {
            let bytes = std::fs::read(cache_dir.join(entry.file)).ok()?;
            if sha256_hex(&bytes) != entry.sha256.to_ascii_lowercase() {
                return None;
            }
            let manifest = serde_json::from_slice::<PluginManifest>(&bytes).ok()?;
            validate_manifest(&manifest).ok()?;
            Some(manifest)
        })
        .collect()
}

fn verify_catalog_signature(index_bytes: &[u8], signature_text: &str) -> Result<(), String> {
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_text)
        .map_err(|_| "Catalog signature is not valid base64".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "Catalog signature has an invalid length".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&CATALOG_PUBLIC_KEY)
        .map_err(|_| "The embedded catalog public key is invalid".to_string())?;
    verifying_key
        .verify(index_bytes, &signature)
        .map_err(|_| "Catalog signature verification failed".to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut temporary = path.to_path_buf();
    temporary.set_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
    ));
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write catalog cache: {error}"))?;
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("Could not activate catalog cache: {error}"))
}

fn load_local_manifests() -> Vec<PluginManifest> {
    let Some(config_dir) = crate::config::config_dir() else {
        return Vec::new();
    };
    let directory = config_dir.join("agent-plugins");
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("yaml" | "yml")
            )
        })
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .filter_map(|contents| serde_yml::from_str(&contents).ok())
        .filter(|manifest: &PluginManifest| manifest.namespace.starts_with("local."))
        .collect()
}

fn validate_manifest(manifest: &PluginManifest) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err("Unsupported plugin schema".into());
    }
    if manifest.provider != "codex" {
        return Err("Only Codex plugins are supported in this release".into());
    }
    if manifest.namespace != "codex" && !manifest.namespace.starts_with("local.") {
        return Err("Invalid plugin namespace".into());
    }
    if manifest.actions.iter().any(|action| {
        !action.id.starts_with(&format!("{}.", manifest.namespace))
            || action.id.len() > 96
            || !action
                .id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    }) {
        return Err("Invalid action identifier".into());
    }
    let allowed_keys = ["C-u", "Escape", "Down", "Enter", "Up"];
    let keys = [
        manifest.ui.stash_key.as_str(),
        manifest.ui.cancel_key.as_str(),
        manifest.ui.next_key.as_str(),
        manifest.ui.submit_key.as_str(),
        manifest.ui.history_key.as_str(),
    ];
    if keys.iter().any(|key| !allowed_keys.contains(key)) {
        return Err("Plugin requests a key outside the safe allowlist".into());
    }
    let commands = [&manifest.ui.model_command, &manifest.ui.compact_command];
    if commands.iter().any(|command| {
        command.len() > 32
            || !command.starts_with('/')
            || !command
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch == '/' || ch == '-')
    }) {
        return Err("Plugin contains an unsafe slash command".into());
    }
    let markers = [
        &manifest.ui.composer_marker,
        &manifest.ui.model_dialog_marker,
        &manifest.ui.effort_dialog_marker,
        &manifest.ui.busy_marker,
    ];
    if markers
        .iter()
        .any(|marker| marker.is_empty() || marker.len() > 64 || marker.contains(['\n', '\r']))
        || manifest.ui.selected_markers.is_empty()
        || manifest
            .ui
            .selected_markers
            .iter()
            .any(|marker| marker.is_empty() || marker.len() > 4 || marker.contains(['\n', '\r']))
    {
        return Err("Plugin contains an unsafe screen marker".into());
    }
    if manifest
        .ui
        .composer_placeholder
        .as_ref()
        .is_some_and(|placeholder| {
            placeholder.is_empty()
                || placeholder.len() > 64
                || placeholder.chars().any(|ch| matches!(ch, '\n' | '\r'))
        })
    {
        return Err("Plugin contains an unsafe composer placeholder".into());
    }
    if manifest
        .ui
        .compact_confirmation_marker
        .as_ref()
        .is_some_and(|marker| {
            marker.is_empty()
                || marker.len() > 64
                || marker.chars().any(|ch| matches!(ch, '\n' | '\r'))
        })
    {
        return Err("Plugin contains an unsafe confirmation marker".into());
    }
    let allowed_efforts = ["low", "medium", "high", "xhigh", "max"];
    if manifest.ui.effort_labels.iter().any(|(effort, label)| {
        !allowed_efforts.contains(&effort.as_str())
            || label.is_empty()
            || label.len() > 32
            || label.chars().any(|ch| matches!(ch, '\n' | '\r'))
    }) {
        return Err("Plugin contains an unsafe effort label".into());
    }
    Ok(())
}

fn version_matches(version: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        pattern
            .strip_suffix(".*")
            .is_some_and(|prefix| version == prefix || version.starts_with(&format!("{prefix}.")))
            || version == pattern
    })
}

struct PrivateScreenState {
    idle: bool,
    has_draft: bool,
    draft: Option<String>,
}

fn private_screen_state(
    pane_id: &str,
    ui: &ProviderUiProfile,
) -> Result<PrivateScreenState, String> {
    let (captured, _) = crate::tmux::capture_pane_visible(pane_id)?;
    Ok(classify_private_screen(&captured, ui))
}

fn classify_private_screen(captured: &str, ui: &ProviderUiProfile) -> PrivateScreenState {
    let plain = strip_ansi(captured);
    let tail: Vec<&str> = plain.lines().rev().take(12).collect();
    let in_dialog = tail.iter().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.contains(&ui.model_dialog_marker.to_ascii_lowercase())
            || lower.contains(&ui.effort_dialog_marker.to_ascii_lowercase())
            || lower.contains(&ui.busy_marker.to_ascii_lowercase())
            || lower.contains("press enter to confirm")
    });
    let composer = tail.iter().find_map(|line| {
        let trimmed = line.trim_start();
        trimmed
            .strip_prefix(&ui.composer_marker)
            .map(|text| text.trim().to_string())
    });
    let composer = composer.map(|text| {
        if ui
            .composer_placeholder
            .as_deref()
            .is_some_and(|placeholder| placeholder == text)
        {
            String::new()
        } else {
            text
        }
    });
    let has_draft = composer.as_deref().is_some_and(|text| !text.is_empty());
    PrivateScreenState {
        idle: composer.is_some() && !in_dialog,
        has_draft,
        draft: composer,
    }
}

fn strip_ansi(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for code in chars.by_ref() {
                if ('@'..='~').contains(&code) {
                    break;
                }
            }
        } else if ch != '\r' {
            result.push(ch);
        }
    }
    result
}

fn submit_command(pane_id: &str, command: &str, ui: &ProviderUiProfile) -> Result<(), String> {
    crate::tmux::send_literal_to_pane(pane_id, command)?;
    crate::tmux::send_key_to_pane(pane_id, &ui.submit_key)
}

async fn confirm_compact_if_requested(pane_id: &str, ui: &ProviderUiProfile) -> Result<(), String> {
    let Some(marker) = ui.compact_confirmation_marker.as_deref() else {
        return Ok(());
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    if private_capture_plain(pane_id)?
        .to_ascii_lowercase()
        .contains(&marker.to_ascii_lowercase())
    {
        crate::tmux::send_key_to_pane(pane_id, &ui.submit_key)?;
    }
    Ok(())
}

async fn select_model(
    pane_id: &str,
    pane_pid: &str,
    model: &str,
    effort: Option<&str>,
    ui: &ProviderUiProfile,
    cancel: &CancellationToken,
) -> Result<(), String> {
    ensure_empty_composer(pane_id, ui)?;
    submit_command(pane_id, &ui.model_command, ui)?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    if let Err(error) = choose_visible_option(pane_id, model, ui, cancel).await {
        let _ = crate::tmux::send_key_to_pane(pane_id, &ui.cancel_key);
        return Err(error);
    }
    if let Some(effort) = effort {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let screen = private_capture_plain(pane_id)?;
        if screen
            .to_ascii_lowercase()
            .contains(&ui.effort_dialog_marker.to_ascii_lowercase())
        {
            let effort_label = ui
                .effort_labels
                .get(effort)
                .map(String::as_str)
                .unwrap_or(effort);
            if let Err(error) = choose_visible_option(pane_id, effort_label, ui, cancel).await {
                let _ = crate::tmux::send_key_to_pane(pane_id, &ui.cancel_key);
                return Err(error);
            }
        }
    }
    wait_for_model(pane_pid, model, effort, cancel).await?;
    wait_until_idle(pane_id, ui, cancel, Duration::from_secs(5)).await
}

async fn choose_visible_option(
    pane_id: &str,
    target: &str,
    ui: &ProviderUiProfile,
    cancel: &CancellationToken,
) -> Result<(), String> {
    for _ in 0..32 {
        if cancel.is_cancelled() {
            return Err("Action cancelled".into());
        }
        let screen = private_capture_plain(pane_id)?;
        let target_lower = target.to_ascii_lowercase();
        let selected = screen
            .lines()
            .any(|line| selected_option_matches(line, &target_lower, &ui.selected_markers));
        if selected {
            crate::tmux::send_key_to_pane(pane_id, &ui.submit_key)?;
            return Ok(());
        }
        crate::tmux::send_key_to_pane(pane_id, &ui.next_key)?;
        tokio::time::sleep(Duration::from_millis(45)).await;
    }
    Err("Could not safely select the requested option".into())
}

fn selected_option_matches(line: &str, target_lower: &str, markers: &[String]) -> bool {
    let trimmed = line.trim_start();
    let Some(marker) = markers.iter().find(|marker| trimmed.starts_with(*marker)) else {
        return false;
    };
    let mut option = trimmed[marker.len()..].trim_start();
    if let Some((ordinal, rest)) = option.split_once('.') {
        if !ordinal.is_empty() && ordinal.chars().all(|ch| ch.is_ascii_digit()) {
            option = rest.trim_start();
        }
    }
    let option_lower = option.to_lowercase();
    let Some(remainder) = option_lower.strip_prefix(target_lower) else {
        return false;
    };
    remainder.is_empty()
        || remainder.starts_with(char::is_whitespace)
        || remainder.starts_with('(')
        || remainder.starts_with('…')
}

fn private_capture_plain(pane_id: &str) -> Result<String, String> {
    let (captured, _) = crate::tmux::capture_pane_visible(pane_id)?;
    Ok(strip_ansi(&captured))
}

async fn wait_for_model(
    pane_pid: &str,
    model: &str,
    effort: Option<&str>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < MODEL_VERIFY_TIMEOUT {
        if cancel.is_cancelled() {
            return Err("Action cancelled".into());
        }
        let info = agent_session::resolve_session_info_for_provider(
            pane_pid,
            Some(ProcessProvider::Codex),
            None,
        );
        if info.model_id.as_deref() == Some(model)
            && effort.is_none_or(|expected| info.agent_effort.as_deref() == Some(expected))
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("Codex did not confirm the requested model and effort".into())
}

async fn wait_until_idle(
    pane_id: &str,
    ui: &ProviderUiProfile,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if cancel.is_cancelled() {
            return Err("Action cancelled".into());
        }
        if started.elapsed() >= timeout {
            return Err("Timed out waiting for Codex to return to its composer".into());
        }
        if started.elapsed() > Duration::from_millis(500) && private_screen_state(pane_id, ui)?.idle
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn wait_until_empty_composer(
    pane_id: &str,
    ui: &ProviderUiProfile,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if cancel.is_cancelled() {
            return Err("Action cancelled".into());
        }
        if started.elapsed() >= timeout {
            return Err("Could not safely clear the Codex composer draft".into());
        }
        let screen = private_screen_state(pane_id, ui)?;
        if screen.idle && !screen.has_draft {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn restore_draft(pane_id: &str, draft: &str, ui: &ProviderUiProfile) -> Result<(), String> {
    ensure_empty_composer(pane_id, ui)?;
    crate::tmux::send_literal_to_pane(pane_id, draft)?;
    Ok(())
}

fn ensure_empty_composer(pane_id: &str, ui: &ProviderUiProfile) -> Result<(), String> {
    let screen = private_screen_state(pane_id, ui)?;
    if screen.idle && !screen.has_draft {
        Ok(())
    } else {
        Err("The composer changed while the action was running".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_private_screen, selected_option_matches, strip_ansi, validate_manifest,
        version_matches, ActionKind, CatalogAction, PluginManifest, ProviderUiProfile,
    };

    #[test]
    fn strips_terminal_control_sequences_without_exposing_capture() {
        assert_eq!(strip_ansi("\u{1b}[31m› draft\u{1b}[0m\r\n"), "› draft\n");
    }

    #[test]
    fn compatibility_is_explicit() {
        assert!(version_matches("0.149.3", &["0.149.*".into()]));
        assert!(!version_matches("0.150.0", &["0.149.*".into()]));
    }

    #[test]
    fn picker_selection_requires_an_exact_option_boundary() {
        let markers = vec!["›".to_string(), ">".to_string()];
        assert!(selected_option_matches(
            "› 5. gpt-5.4 (current)",
            "gpt-5.4",
            &markers
        ));
        assert!(!selected_option_matches(
            "› 6. gpt-5.4-mini",
            "gpt-5.4",
            &markers
        ));
        assert!(!selected_option_matches(
            "› 4. Extra high",
            "high",
            &markers
        ));
        assert!(selected_option_matches(
            "› 5. More reasoning… (current)",
            "more reasoning",
            &markers
        ));
    }

    #[test]
    fn local_namespace_cannot_shadow_first_party_actions() {
        let manifest = PluginManifest {
            schema_version: 1,
            namespace: "local.example".into(),
            provider: "codex".into(),
            compatible_versions: vec!["0.149.*".into()],
            ui: ProviderUiProfile::default(),
            actions: vec![CatalogAction {
                id: "codex.set_model".into(),
                title: "Bad".into(),
                description: String::new(),
                kind: ActionKind::SetModel,
            }],
        };
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn declarative_profile_rejects_unapproved_keys() {
        let mut ui = ProviderUiProfile::default();
        ui.next_key = "run-shell".into();
        let manifest = PluginManifest {
            schema_version: 1,
            namespace: "local.example".into(),
            provider: "codex".into(),
            compatible_versions: vec!["0.149.*".into()],
            ui,
            actions: vec![CatalogAction {
                id: "local.example.next".into(),
                title: "Next".into(),
                description: String::new(),
                kind: ActionKind::NextModel,
            }],
        };
        assert!(validate_manifest(&manifest).is_err());
    }

    #[test]
    fn composer_gate_distinguishes_idle_draft_and_dialog() {
        let ui = ProviderUiProfile::default();
        let placeholder =
            classify_private_screen("work complete\n\n› Ask Codex to do anything\n", &ui);
        assert!(placeholder.idle);
        assert!(!placeholder.has_draft);
        assert_eq!(placeholder.draft.as_deref(), Some(""));

        let empty = classify_private_screen("work complete\n\n› \n", &ui);
        assert!(empty.idle);
        assert!(!empty.has_draft);

        let draft = classify_private_screen("work complete\n\n› keep this text\n", &ui);
        assert!(draft.idle);
        assert!(draft.has_draft);
        assert_eq!(draft.draft.as_deref(), Some("keep this text"));

        let picker = classify_private_screen("Select model\n› gpt-5.6-luna\n", &ui);
        assert!(!picker.idle);

        let working = classify_private_screen("esc to interrupt\n› \n", &ui);
        assert!(!working.idle);
    }

    #[test]
    fn interrupt_cannot_be_used_to_clear_a_plugin_draft() {
        let mut ui = ProviderUiProfile::default();
        ui.stash_key = "C-c".into();
        let manifest = PluginManifest {
            schema_version: 1,
            namespace: "local.example".into(),
            provider: "codex".into(),
            compatible_versions: vec!["0.149.*".into()],
            ui,
            actions: Vec::new(),
        };
        assert!(validate_manifest(&manifest).is_err());
    }
}
