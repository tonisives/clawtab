use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use crate::config::jobs::{Job, NotifyTarget};
use crate::config::settings::AppSettings;
use crate::secrets::SecretsManager;

trait RuntimeSecrets {
    fn reload(&mut self);
    fn list_keys(&self) -> Vec<String>;
    fn get(&self, key: &str) -> Option<&str>;
}

impl RuntimeSecrets for SecretsManager {
    fn reload(&mut self) {
        SecretsManager::reload(self);
    }

    fn list_keys(&self) -> Vec<String> {
        SecretsManager::list_keys(self)
    }

    fn get(&self, key: &str) -> Option<&str> {
        SecretsManager::get(self, key).map(String::as_str)
    }
}

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
    let is_agent = job.name == "agent";
    let mut sm = secrets.lock();
    let mut vars = collect_secret_env_vars(&mut *sm, &job.secret_keys, is_agent, &job.slug);
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

fn collect_secret_env_vars(
    secrets: &mut impl RuntimeSecrets,
    configured_keys: &[String],
    inject_all: bool,
    job_slug: &str,
) -> Vec<(String, String)> {
    if !inject_all && configured_keys.is_empty() {
        return Vec::new();
    }

    secrets.reload();

    let keys = if inject_all {
        secrets.list_keys()
    } else {
        configured_keys.to_vec()
    };

    keys.into_iter()
        .filter_map(|key| match secrets.get(&key) {
            Some(value) => Some((key, value.to_string())),
            None => {
                log::warn!(
                    "Secret key '{}' is configured for '{}' but was not found",
                    key,
                    job_slug
                );
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{collect_secret_env_vars, RuntimeSecrets};

    struct MockSecrets {
        cached: HashMap<String, String>,
        stored: HashMap<String, String>,
        reloads: usize,
    }

    impl RuntimeSecrets for MockSecrets {
        fn reload(&mut self) {
            self.cached = self.stored.clone();
            self.reloads += 1;
        }

        fn list_keys(&self) -> Vec<String> {
            self.cached.keys().cloned().collect()
        }

        fn get(&self, key: &str) -> Option<&str> {
            self.cached.get(key).map(String::as_str)
        }
    }

    #[test]
    fn reloads_secrets_before_collecting_job_environment() {
        let mut secrets = MockSecrets {
            cached: HashMap::from([("DB_TSKR".to_string(), "stale".to_string())]),
            stored: HashMap::from([("DB_TSKR".to_string(), "current".to_string())]),
            reloads: 0,
        };

        let vars = collect_secret_env_vars(
            &mut secrets,
            &["DB_TSKR".to_string()],
            false,
            "tskr/sector-brief-editor",
        );

        assert_eq!(vars, vec![("DB_TSKR".to_string(), "current".to_string())]);
        assert_eq!(secrets.reloads, 1);
    }
}
