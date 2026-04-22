use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::config::jobs::JobStatus;
use crate::config::settings::AppSettings;
use crate::history::HistoryStore;
use crate::relay::RelayHandle;
use crate::secrets::SecretsManager;
use crate::telegram::ActiveAgent;

/// Shared state bundle passed to job execution, scheduling, reattach, and relay handlers.
/// Every field is an `Arc`, so `.clone()` is cheap and refcount-bumps only.
#[derive(Clone)]
pub struct JobContext {
    pub secrets: Arc<Mutex<SecretsManager>>,
    pub history: Arc<Mutex<HistoryStore>>,
    pub settings: Arc<Mutex<AppSettings>>,
    pub job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    pub active_agents: Arc<Mutex<HashMap<i64, ActiveAgent>>>,
    pub relay: Arc<Mutex<Option<RelayHandle>>>,
    pub auto_yes_panes: Arc<Mutex<HashSet<String>>>,
    pub protected_panes: Arc<Mutex<HashSet<String>>>,
    pub notifier: Option<Arc<dyn crate::notifications::Notifier>>,
}
