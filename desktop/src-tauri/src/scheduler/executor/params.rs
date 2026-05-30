use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use crate::config::jobs::{Job, NotifyTarget};
use crate::config::settings::AppSettings;
use crate::secrets::SecretsManager;

/// Fill missing entries in a runtime params HashMap from each JobParam's default value.
/// Explicit values already in the map take precedence; only params with a `value` default
/// are auto-filled when absent.
pub(super) fn apply_param_defaults(job: &Job, params: &mut HashMap<String, String>) {
    for p in &job.params {
        if let Some(default) = &p.value {
            params
                .entry(p.name.clone())
                .or_insert_with(|| default.clone());
        }
    }
}

/// Replace `{key}` placeholders in a prompt string with the provided param values.
pub(super) fn apply_params(mut prompt: String, params: &HashMap<String, String>) -> String {
    for (key, value) in params {
        prompt = prompt.replace(&format!("{{{}}}", key), value);
    }
    prompt
}

/// Collect env vars from job's secret_keys as (key, value) pairs.
/// Also auto-injects TELEGRAM_BOT_TOKEN from global settings when the job
/// has a telegram_chat_id but doesn't explicitly list the token in secret_keys.
pub(super) fn collect_env_vars(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
) -> Vec<(String, String)> {
    let sm = secrets.lock();
    let mut vars = Vec::new();

    let is_agent = job.name == "agent";

    if is_agent {
        for key in sm.list_keys() {
            if let Some(value) = sm.get(&key) {
                vars.push((key, value.clone()));
            }
        }
    } else {
        for key in &job.secret_keys {
            if let Some(value) = sm.get(key) {
                vars.push((key.clone(), value.clone()));
            } else {
                log::warn!(
                    "Secret key '{}' is configured for '{}' but was not found",
                    key,
                    job.slug
                );
            }
        }
    }
    drop(sm);

    for (key, value) in &job.env {
        vars.push((key.clone(), value.clone()));
    }

    if !vars.iter().any(|(k, _)| k == "TELEGRAM_BOT_TOKEN") {
        if job.notify_target == NotifyTarget::Telegram || is_agent {
            let s = settings.lock();
            if let Some(ref tg) = s.telegram {
                if !tg.bot_token.is_empty() {
                    vars.push(("TELEGRAM_BOT_TOKEN".to_string(), tg.bot_token.clone()));
                }
            }
        }
    }

    vars
}
