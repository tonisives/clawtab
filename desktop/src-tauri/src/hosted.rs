//! Admission shared by the daemon, scheduler, and local CLI on included hosts.
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
};

pub const CAPACITY_ERROR: &str = "Both included workspace sessions are in use. Stop a session, connect a machine, or rent a machine.";
const POLICY: &str = "/etc/clawtab-hosted/policy.json";

#[derive(Clone, Deserialize)]
pub struct Policy {
    pub sessions: usize,
    pub jobs: usize,
}

pub fn policy() -> Result<Option<Policy>, String> {
    match std::fs::read(POLICY) {
        Ok(bytes) => {
            let policy: Policy =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid hosted policy")?;
            if policy.sessions == 0 || policy.jobs == 0 {
                return Err("Invalid hosted policy".into());
            }
            Ok(Some(policy))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Hosted policy unavailable".into()),
    }
}

pub fn enabled() -> bool {
    Path::new(POLICY).exists()
}

#[derive(Serialize, Deserialize)]
struct Entry {
    id: String,
    owner: u32,
    #[serde(default)]
    owner_start: Option<String>,
    pane: Option<String>,
}

struct LockedState {
    _lock: File,
    path: PathBuf,
    entries: Vec<Entry>,
}

impl LockedState {
    fn open(root: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(|_| "Workspace state unavailable")?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("hosted-admission.lock"))
            .map_err(|_| "Workspace admission unavailable")?;
        FileExt::lock_exclusive(&lock).map_err(|_| "Workspace admission unavailable")?;
        let path = root.join("hosted-admission.json");
        let entries = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "Workspace admission state is invalid")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(_) => return Err("Workspace admission state unavailable".into()),
        };
        Ok(Self {
            _lock: lock,
            path,
            entries,
        })
    }
    fn reap(&mut self) {
        self.entries.retain(|entry| match entry.pane.as_deref() {
            Some(pane) => match crate::terminal_backend::pane_process_state(pane) {
                Ok(
                    crate::terminal_backend::PaneProcessState::Exited(_)
                    | crate::terminal_backend::PaneProcessState::Missing,
                ) => false,
                _ => true,
            },
            None => process_alive(entry.owner) && entry.owner_start == process_start(entry.owner),
        });
    }
    fn save(&self) -> Result<(), String> {
        let bytes =
            serde_json::to_vec(&self.entries).map_err(|_| "Could not save workspace admission")?;
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, bytes)
            .and_then(|_| std::fs::rename(temporary, &self.path))
            .map_err(|_| "Could not save workspace admission".into())
    }
}

#[cfg(target_os = "linux")]
fn process_start(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm is parenthesized and may contain spaces; starttime is field 22.
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)
        .map(str::to_owned)
}
#[cfg(not(target_os = "linux"))]
fn process_start(_pid: u32) -> Option<String> {
    None
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // kill with signal zero only checks process existence.
    unsafe {
        libc::kill(pid as i32, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}
#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    true
}

pub struct SessionLease {
    root: PathBuf,
    id: String,
    bound: bool,
}

impl SessionLease {
    fn acquire(root: PathBuf, maximum: usize) -> Result<Self, String> {
        let mut state = LockedState::open(&root)?;
        state.reap();
        if state.entries.len() >= maximum {
            return Err(CAPACITY_ERROR.into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        state.entries.push(Entry {
            id: id.clone(),
            owner: std::process::id(),
            owner_start: process_start(std::process::id()),
            pane: None,
        });
        state.save()?;
        Ok(Self {
            root,
            id,
            bound: false,
        })
    }
    pub fn bind(&mut self, pane: &str) -> Result<(), String> {
        let mut state = LockedState::open(&self.root)?;
        let entry = state
            .entries
            .iter_mut()
            .find(|entry| entry.id == self.id)
            .ok_or("Workspace admission expired")?;
        entry.pane = Some(pane.into());
        state.save()?;
        self.bound = true;
        Ok(())
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        if self.bound {
            return;
        }
        if let Ok(mut state) = LockedState::open(&self.root) {
            state.entries.retain(|entry| entry.id != self.id);
            let _ = state.save();
        }
    }
}

pub fn admit() -> Result<Option<SessionLease>, String> {
    let Some(policy) = policy()? else {
        return Ok(None);
    };
    let root = crate::config::config_dir().ok_or("Workspace state directory unavailable")?;
    SessionLease::acquire(root, policy.sessions).map(Some)
}

pub fn check_job_count(jobs: &[crate::config::jobs::Job], slug: &str) -> Result<(), String> {
    let Some(policy) = policy()? else {
        return Ok(());
    };
    if !jobs.iter().any(|job| job.slug == slug) && jobs.len() >= policy.jobs {
        return Err("Included workspaces support two saved jobs. Delete a job, connect a machine, or rent a machine.".into());
    }
    Ok(())
}

pub struct JobWriteGuard {
    _lock: File,
}

pub fn job_write_guard() -> Result<Option<JobWriteGuard>, String> {
    if policy()?.is_none() {
        return Ok(None);
    }
    let root = crate::config::config_dir().ok_or("Workspace state directory unavailable")?;
    std::fs::create_dir_all(&root).map_err(|_| "Workspace state unavailable")?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("hosted-jobs.lock"))
        .map_err(|_| "Workspace job admission unavailable")?;
    FileExt::lock_exclusive(&lock).map_err(|_| "Workspace job admission unavailable")?;
    Ok(Some(JobWriteGuard { _lock: lock }))
}

pub fn pending_jobs() -> Result<Vec<String>, String> {
    let root = crate::config::config_dir().ok_or("Workspace state directory unavailable")?;
    let _state = LockedState::open(&root)?;
    read_pending(&root)
}

fn read_pending(root: &Path) -> Result<Vec<String>, String> {
    match std::fs::read(root.join("hosted-pending.json")) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "Workspace queue is invalid".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err("Workspace queue unavailable".into()),
    }
}

pub fn queue_job(slug: &str, remove: bool) -> Result<(), String> {
    let root = crate::config::config_dir().ok_or("Workspace state directory unavailable")?;
    let _state = LockedState::open(&root)?;
    let mut pending = read_pending(&root)?;
    pending.retain(|saved| saved != slug);
    if !remove && pending.len() < 2 {
        pending.push(slug.into());
    }
    let bytes = serde_json::to_vec(&pending).map_err(|_| "Could not save workspace queue")?;
    let temporary = root.join("hosted-pending.tmp");
    std::fs::write(&temporary, bytes)
        .and_then(|_| std::fs::rename(temporary, root.join("hosted-pending.json")))
        .map_err(|_| "Could not save workspace queue".into())
}

pub fn restrict_loaded_jobs(jobs: &mut Vec<crate::config::jobs::Job>) {
    match policy() {
        Ok(Some(policy)) if jobs.len() > policy.jobs => {
            jobs.sort_by(|a, b| a.added_at.cmp(&b.added_at).then(a.slug.cmp(&b.slug)));
            jobs.truncate(policy.jobs);
            log::warn!(
                "Included workspace job allowance reached; excess definitions were left on disk"
            );
        }
        Err(error) => {
            log::error!("{error}");
            jobs.clear();
        }
        _ => {}
    }
}

pub fn info() -> Value {
    if !enabled() {
        return Value::Null;
    }
    let sessions = crate::config::config_dir()
        .and_then(|root| LockedState::open(&root).ok())
        .map(|mut state| {
            state.reap();
            let count = state.entries.len();
            let _ = state.save();
            count
        });
    let storage = storage_usage();
    json!({"limits":{"sessions":2,"jobs":2,"cpu_millis":500,"memory_bytes":524_288_000_u64,"storage_bytes":524_288_000_u64},"usage":{"sessions":sessions,"jobs":crate::config::jobs::JobsConfig::load().jobs.len(),"storage_bytes":storage},"pending_jobs":pending_jobs().unwrap_or_default()})
}

#[cfg(unix)]
fn storage_usage() -> Option<u64> {
    let home = dirs::home_dir()?;
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(home.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // statvfs initializes stat only on success.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return None;
    }
    let stat = unsafe { stat.assume_init() };
    Some((stat.f_blocks - stat.f_bfree) as u64 * stat.f_frsize as u64)
}
#[cfg(not(unix))]
fn storage_usage() -> Option<u64> {
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_reservations_never_exceed_two_and_failures_release() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_owned();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let handles = (0..8)
            .map(|_| {
                let root = root.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    SessionLease::acquire(root, 2).ok()
                })
            })
            .collect::<Vec<_>>();
        let leases = handles
            .into_iter()
            .filter_map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(leases.len(), 2);
        assert!(SessionLease::acquire(root.clone(), 2).is_err());
        drop(leases);
        assert!(SessionLease::acquire(root, 2).is_ok());
    }
    #[test]
    fn abandoned_reservations_are_recovered() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut state = LockedState::open(root).unwrap();
        state.entries.push(Entry {
            id: "abandoned".into(),
            owner: 2_000_000_000,
            owner_start: None,
            pane: None,
        });
        state.save().unwrap();
        drop(state);
        assert!(SessionLease::acquire(root.into(), 1).is_ok());
    }
}
