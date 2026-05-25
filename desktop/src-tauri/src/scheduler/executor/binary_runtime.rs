use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::config::jobs::{Job, JobStatus, JobType, JobsConfig};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryRuntimeState {
    pub slug: String,
    pub run_id: String,
    pub started_at: String,
    pub pid: u32,
    pub pgid: i32,
}

static RUNNING: OnceLock<Mutex<HashMap<String, BinaryRuntimeState>>> = OnceLock::new();

fn running() -> &'static Mutex<HashMap<String, BinaryRuntimeState>> {
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register(job: &Job, run_id: &str, started_at: &str, pid: u32) {
    let state = BinaryRuntimeState {
        slug: job.slug.clone(),
        run_id: run_id.to_string(),
        started_at: started_at.to_string(),
        pid,
        pgid: pid as i32,
    };
    running().lock().insert(job.slug.clone(), state.clone());
    if let Err(e) = write_state(&state) {
        log::warn!(
            "Failed to persist binary runtime state for {}: {}",
            job.slug,
            e
        );
    }
}

pub fn unregister(slug: &str) {
    running().lock().remove(slug);
    if let Some(path) = runtime_path(slug) {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "Failed to remove binary runtime file {}: {}",
                    path.display(),
                    e
                );
            }
        }
    }
}

pub fn stop(slug: &str) -> Result<bool, String> {
    if let Some(state) = running()
        .lock()
        .get(slug)
        .cloned()
        .or_else(|| read_state(slug))
    {
        kill_process_group(&state)?;
        return Ok(true);
    }
    if let Some(state) = discover_external_state(slug, None) {
        kill_process_group(&state)?;
        return Ok(true);
    }
    Ok(false)
}

pub fn is_running(slug: &str) -> bool {
    let state = running()
        .lock()
        .get(slug)
        .cloned()
        .or_else(|| read_state(slug));
    let Some(state) = state else {
        return false;
    };
    if process_alive(state.pid) {
        return true;
    }
    unregister(slug);
    false
}

pub fn reattach_running_binary_jobs(jobs_config: &JobsConfig) -> HashMap<String, JobStatus> {
    let mut statuses = HashMap::new();
    for job in jobs_config
        .jobs
        .iter()
        .filter(|job| matches!(job.job_type, JobType::Binary))
    {
        let Some(state) = read_state(&job.slug) else {
            continue;
        };
        if !process_alive(state.pid) {
            unregister(&job.slug);
            continue;
        }
        running().lock().insert(job.slug.clone(), state.clone());
        statuses.insert(job.slug.clone(), status_from_state(state));
    }
    for job in jobs_config
        .jobs
        .iter()
        .filter(|job| matches!(job.job_type, JobType::Binary))
    {
        if statuses.contains_key(&job.slug) {
            continue;
        }
        if let Some(state) = discover_external_state(&job.slug, Some(job)) {
            log::info!(
                "Discovered running binary job '{}' pid={} pgid={}",
                job.slug,
                state.pid,
                state.pgid
            );
            running().lock().insert(job.slug.clone(), state.clone());
            statuses.insert(job.slug.clone(), status_from_state(state));
        }
    }
    statuses
}

fn status_from_state(state: BinaryRuntimeState) -> JobStatus {
    JobStatus::Running {
        run_id: state.run_id,
        started_at: state.started_at,
        pane_id: None,
        tmux_session: None,
    }
}

fn runtime_path(slug: &str) -> Option<std::path::PathBuf> {
    JobsConfig::jobs_dir_public().map(|dir| dir.join(slug).join("runtime.json"))
}

fn write_state(state: &BinaryRuntimeState) -> Result<(), String> {
    let path = runtime_path(&state.slug).ok_or_else(|| "Could not resolve jobs dir".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(state).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn read_state(slug: &str) -> Option<BinaryRuntimeState> {
    let path = runtime_path(slug)?;
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn discover_external_state(slug: &str, job: Option<&Job>) -> Option<BinaryRuntimeState> {
    let job_dir = JobsConfig::jobs_dir_public()
        .map(|dir| dir.join(slug).to_string_lossy().into_owned())
        .unwrap_or_default();
    let job_path = job.map(|j| j.path.clone()).unwrap_or_default();
    let output = std::process::Command::new("ps")
        .args(["-Ao", "pid=,ppid=,pgid=,command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let row = parse_ps_row(line)?;
        if row.command.contains("clawtab-daemon") || row.command.contains("ClawTab.app") {
            continue;
        }
        let matches_job_dir = !job_dir.is_empty() && row.command.contains(&job_dir);
        let matches_job_path = !job_path.is_empty() && row.command.contains(&job_path);
        if !matches_job_dir && !matches_job_path {
            continue;
        }
        return Some(BinaryRuntimeState {
            slug: slug.to_string(),
            run_id: format!("external-{}", row.pid),
            started_at: chrono::Utc::now().to_rfc3339(),
            pid: row.pid,
            pgid: row.pgid,
        });
    }
    None
}

struct PsRow<'a> {
    pid: u32,
    pgid: i32,
    command: &'a str,
}

fn parse_ps_row(line: &str) -> Option<PsRow<'_>> {
    let trimmed = line.trim_start();
    let (pid_raw, rest) = take_token(trimmed)?;
    let (_ppid_raw, rest) = take_token(rest)?;
    let (pgid_raw, command) = take_token(rest)?;
    let pid = pid_raw.parse().ok()?;
    let pgid = pgid_raw.parse().ok()?;
    Some(PsRow { pid, pgid, command })
}

fn take_token(input: &str) -> Option<(&str, &str)> {
    let trimmed = input.trim_start();
    let split_at = trimmed.find(char::is_whitespace)?;
    let token = &trimmed[..split_at];
    let rest = &trimmed[split_at..];
    Some((token, rest.trim_start()))
}

fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0
}

fn kill_process_group(state: &BinaryRuntimeState) -> Result<(), String> {
    let pgid = state.pgid;
    if pgid <= 0 {
        return Err(format!("Invalid process group for {}", state.slug));
    }
    let result = unsafe { libc::kill(-pgid, libc::SIGTERM) };
    if result == 0 {
        unregister(&state.slug);
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        unregister(&state.slug);
        return Ok(());
    }
    Err(format!(
        "Failed to stop {} process group {}: {}",
        state.slug, pgid, err
    ))
}
