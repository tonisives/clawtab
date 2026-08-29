use chrono::{DateTime, Duration, TimeZone, Utc};
use chrono_tz::Tz;
use clawtab_protocol::JobPolicy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

const DEFAULT_COOLDOWN: Duration = Duration::minutes(90);
const DEFAULT_BUSY_RETRY: Duration = Duration::minutes(1);
const DEFAULT_DAILY_LIMIT: u32 = 4;

/// Admission settings for machine-local resources. The production values are
/// intentionally fixed in this module; the timezone is configurable because
/// the daily CRM quota follows the project's calendar rather than the host's.
#[derive(Clone)]
pub struct ResourcePolicyConfig {
    pub timezone: Tz,
    pub cooldown: Duration,
    pub busy_retry: Duration,
    pub daily_limit: u32,
}

impl Default for ResourcePolicyConfig {
    fn default() -> Self {
        Self {
            timezone: Tz::UTC,
            cooldown: DEFAULT_COOLDOWN,
            busy_retry: DEFAULT_BUSY_RETRY,
            daily_limit: DEFAULT_DAILY_LIMIT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceRejection {
    pub status: &'static str,
    pub message: String,
    pub retry_at: Option<DateTime<Utc>>,
}

#[derive(Clone)]
pub struct ResourcePolicyManager {
    state: Arc<Mutex<PolicyState>>,
    config: ResourcePolicyConfig,
    state_path: Option<PathBuf>,
}

#[derive(Default)]
struct PolicyState {
    persisted: PersistedState,
    active: HashMap<String, ActiveLease>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct PersistedState {
    resources: HashMap<String, PersistedResource>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct PersistedResource {
    last_completed_at: Option<DateTime<Utc>>,
    daily_counts: HashMap<String, u32>,
}

struct ActiveLease {
    lease_id: Uuid,
    day_key: String,
}

/// A lease is held until the executor has finished the process. Dropping an
/// uncommitted lease rolls back the daily reservation; dropping a committed
/// lease records completion and starts the cooldown.
pub struct ResourceLease {
    manager: ResourcePolicyManager,
    resource_key: String,
    lease_id: Uuid,
    day_key: String,
    committed: bool,
    released: bool,
}

impl ResourcePolicyManager {
    pub fn from_environment() -> Self {
        let mut config = ResourcePolicyConfig::default();
        if let Ok(value) = std::env::var("CLAWTAB_RESOURCE_POLICY_TIMEZONE") {
            match value.parse::<Tz>() {
                Ok(timezone) => config.timezone = timezone,
                Err(error) => log::warn!(
                    "invalid CLAWTAB_RESOURCE_POLICY_TIMEZONE {:?}: {}; using UTC",
                    value,
                    error
                ),
            }
        }
        let state_path = crate::config::config_dir().map(|dir| dir.join("resource-policy.json"));
        Self::with_path(config, state_path)
    }

    fn with_path(config: ResourcePolicyConfig, state_path: Option<PathBuf>) -> Self {
        let persisted = state_path
            .as_deref()
            .and_then(load_state)
            .unwrap_or_default();
        Self {
            state: Arc::new(Mutex::new(PolicyState {
                persisted,
                active: HashMap::new(),
            })),
            config,
            state_path,
        }
    }

    pub fn try_acquire(&self, policy: JobPolicy) -> Result<ResourceLease, ResourceRejection> {
        self.try_acquire_at(policy, Utc::now())
    }

    pub fn try_acquire_at(
        &self,
        policy: JobPolicy,
        now: DateTime<Utc>,
    ) -> Result<ResourceLease, ResourceRejection> {
        let resource_key = policy.resource_key().to_string();
        let day_key = self.day_key(now);
        let mut state = self.state.lock();

        if state.active.contains_key(&resource_key) {
            return Err(ResourceRejection {
                status: "deferred",
                message: format!("resource `{resource_key}` is already running"),
                retry_at: Some(now + self.config.busy_retry),
            });
        }

        let previous = state.persisted.clone();
        {
            let resource = state
                .persisted
                .resources
                .entry(resource_key.clone())
                .or_default();
            resource.daily_counts.retain(|key, _| key == &day_key);

            let count = resource.daily_counts.get(&day_key).copied().unwrap_or(0);
            if count >= self.config.daily_limit {
                let mut retry_at = self.next_day_start(now);
                if let Some(last_completed_at) = resource.last_completed_at {
                    retry_at = retry_at.max(last_completed_at + self.config.cooldown);
                }
                return Err(ResourceRejection {
                    status: "deferred",
                    message: format!(
                        "resource `{resource_key}` reached its daily limit of {}",
                        self.config.daily_limit
                    ),
                    retry_at: Some(retry_at),
                });
            }
            if let Some(last_completed_at) = resource.last_completed_at {
                let retry_at = last_completed_at + self.config.cooldown;
                if retry_at > now {
                    return Err(ResourceRejection {
                        status: "deferred",
                        message: format!("resource `{resource_key}` is cooling down"),
                        retry_at: Some(retry_at),
                    });
                }
            }
            resource.daily_counts.insert(day_key.clone(), count + 1);
        }
        let lease_id = Uuid::new_v4();
        state.active.insert(
            resource_key.clone(),
            ActiveLease {
                lease_id,
                day_key: day_key.clone(),
            },
        );
        if let Err(error) = persist_state(self.state_path.as_deref(), &state.persisted) {
            state.persisted = previous;
            state.active.remove(&resource_key);
            log::error!("failed to persist resource admission state: {}", error);
            return Err(ResourceRejection {
                status: "rejected",
                message: "resource policy state could not be persisted".into(),
                retry_at: Some(now + self.config.busy_retry),
            });
        }

        Ok(ResourceLease {
            manager: self.clone(),
            resource_key,
            lease_id,
            day_key,
            committed: false,
            released: false,
        })
    }

    fn day_key(&self, now: DateTime<Utc>) -> String {
        now.with_timezone(&self.config.timezone)
            .date_naive()
            .to_string()
    }

    fn next_day_start(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        let local = now.with_timezone(&self.config.timezone);
        let next_date = local
            .date_naive()
            .succ_opt()
            .unwrap_or_else(|| local.date_naive() + Duration::days(1));
        let local_midnight = next_date
            .and_hms_opt(0, 0, 0)
            .unwrap_or_else(|| local.naive_local() + Duration::days(1));
        match self.config.timezone.from_local_datetime(&local_midnight) {
            chrono::LocalResult::Single(value) => value.with_timezone(&Utc),
            chrono::LocalResult::Ambiguous(first, _) => first.with_timezone(&Utc),
            chrono::LocalResult::None => now + Duration::days(1),
        }
    }

    fn release(&self, resource_key: &str, lease_id: Uuid, day_key: &str, committed: bool) {
        let now = Utc::now();
        let mut state = self.state.lock();
        let Some(active) = state.active.get(resource_key) else {
            return;
        };
        if active.lease_id != lease_id {
            return;
        }
        let active_day_key = active.day_key.clone();
        state.active.remove(resource_key);

        if committed {
            state
                .persisted
                .resources
                .entry(resource_key.to_string())
                .or_default()
                .last_completed_at = Some(now);
        } else if let Some(resource) = state.persisted.resources.get_mut(resource_key) {
            if let Some(count) = resource.daily_counts.get_mut(day_key) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    resource.daily_counts.remove(day_key);
                }
            } else if let Some(count) = resource.daily_counts.get_mut(&active_day_key) {
                *count = count.saturating_sub(1);
            }
        }

        if let Err(error) = persist_state(self.state_path.as_deref(), &state.persisted) {
            log::error!("failed to persist resource release state: {}", error);
        }
    }
}

impl ResourceLease {
    pub fn commit(&mut self) {
        self.committed = true;
    }

    #[cfg(test)]
    fn finish_at(mut self, now: DateTime<Utc>) {
        let mut state = self.manager.state.lock();
        if let Some(active) = state.active.get(&self.resource_key) {
            if active.lease_id == self.lease_id {
                state.active.remove(&self.resource_key);
                if self.committed {
                    state
                        .persisted
                        .resources
                        .entry(self.resource_key.clone())
                        .or_default()
                        .last_completed_at = Some(now);
                }
                let _ = persist_state(self.manager.state_path.as_deref(), &state.persisted);
            }
        }
        self.released = true;
    }
}

impl Drop for ResourceLease {
    fn drop(&mut self) {
        if !self.released {
            self.manager.release(
                &self.resource_key,
                self.lease_id,
                &self.day_key,
                self.committed,
            );
            self.released = true;
        }
    }
}

fn load_state(path: &Path) -> Option<PersistedState> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(state) => Some(state),
            Err(error) => {
                log::warn!("ignoring invalid resource policy state: {}", error);
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            log::warn!("could not read resource policy state: {}", error);
            None
        }
    }
}

fn persist_state(path: Option<&Path>, state: &PersistedState) -> std::io::Result<()> {
    let Some(path) = path else {
        return Ok(());
    };
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent)?;
    let temp_path = parent.join(format!(".resource-policy-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let bytes = serde_json::to_vec(state).map_err(std::io::Error::other)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(test)]
impl ResourcePolicyManager {
    fn for_tests(config: ResourcePolicyConfig) -> Self {
        Self::with_path(config, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Barrier};
    use std::thread;

    fn test_config() -> ResourcePolicyConfig {
        ResourcePolicyConfig {
            timezone: Tz::UTC,
            cooldown: Duration::minutes(90),
            busy_retry: Duration::minutes(1),
            daily_limit: 4,
        }
    }

    #[test]
    fn concurrent_admission_allows_only_one_lease() {
        let manager = Arc::new(ResourcePolicyManager::for_tests(test_config()));
        let start = Arc::new(Barrier::new(8));
        let release = Arc::new(Barrier::new(8));
        let (tx, rx) = mpsc::channel();

        thread::scope(|scope| {
            for _ in 0..8 {
                let manager = Arc::clone(&manager);
                let start = Arc::clone(&start);
                let release = Arc::clone(&release);
                let tx = tx.clone();
                scope.spawn(move || {
                    start.wait();
                    let lease = manager.try_acquire(JobPolicy::CrmSocialResearch).ok();
                    tx.send(lease.is_some()).expect("send admission result");
                    release.wait();
                    drop(lease);
                });
            }
        });

        drop(tx);
        let successes = rx.iter().filter(|won| *won).count();
        assert_eq!(successes, 1);
    }

    #[test]
    fn completion_starts_exact_cooldown() {
        let manager = ResourcePolicyManager::for_tests(test_config());
        let start = DateTime::parse_from_rfc3339("2026-08-29T00:00:00Z")
            .expect("timestamp")
            .with_timezone(&Utc);
        let mut lease = manager
            .try_acquire_at(JobPolicy::CrmSocialResearch, start)
            .expect("first admission");
        lease.commit();
        lease.finish_at(start);

        let before = match manager.try_acquire_at(
            JobPolicy::CrmSocialResearch,
            start + Duration::minutes(89) + Duration::seconds(59),
        ) {
            Ok(_) => panic!("cooldown must defer"),
            Err(error) => error,
        };
        assert_eq!(before.status, "deferred");
        assert_eq!(before.retry_at, Some(start + Duration::minutes(90)));

        let allowed = manager
            .try_acquire_at(JobPolicy::CrmSocialResearch, start + Duration::minutes(90))
            .expect("cooldown has elapsed");
        drop(allowed);
    }

    #[test]
    fn daily_cap_uses_configured_local_calendar_day() {
        let mut config = test_config();
        config.timezone = chrono_tz::America::Los_Angeles;
        config.cooldown = Duration::zero();
        let manager = ResourcePolicyManager::for_tests(config);
        let start = DateTime::parse_from_rfc3339("2026-08-30T06:59:00Z")
            .expect("timestamp")
            .with_timezone(&Utc);

        for index in 0..4 {
            let mut lease = manager
                .try_acquire_at(
                    JobPolicy::CrmSocialResearch,
                    start + Duration::seconds(index),
                )
                .expect("daily admission");
            lease.commit();
            lease.finish_at(start + Duration::seconds(index));
        }

        let rejected = match manager
            .try_acquire_at(JobPolicy::CrmSocialResearch, start + Duration::seconds(10))
        {
            Ok(_) => panic!("daily cap must defer"),
            Err(error) => error,
        };
        assert_eq!(rejected.status, "deferred");
        assert_eq!(rejected.retry_at, Some(start + Duration::minutes(1)));
    }
}
