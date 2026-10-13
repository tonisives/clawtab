//! Durable moves belong to the daemon, not to the initiating app connection.
mod peer;
use super::security::{self, Identity};
use crate::{
    agent_session::{self, ProcessProvider, ProcessSnapshot},
    job_context::JobContext,
};
use base64::Engine;
use clawtab_protocol::HostRequest;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::LazyLock,
    time::Duration,
};

static RUNNING: LazyLock<parking_lot::Mutex<HashSet<String>>> =
    LazyLock::new(|| parking_lot::Mutex::new(HashSet::new()));
static RECORD_LOCK: LazyLock<parking_lot::Mutex<()>> =
    LazyLock::new(|| parking_lot::Mutex::new(()));

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Source {
    pane_id: String,
    execution_id: String,
    pane_pid: String,
    cwd: String,
    provider: ProcessProvider,
    session_id: String,
    model: Option<String>,
    effort: Option<String>,
    secret_keys: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct PausedProcess {
    pid: String,
    started: i64,
    command_hash: String,
    already_stopped: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct MoveRecord {
    created_at: i64,
    operation_id: String,
    source: Source,
    target: String,
    destination: String,
    setup: bool,
    state: String,
    progress: String,
    paused: Vec<PausedProcess>,
    manifest: Option<Value>,
    remote: Option<Value>,
    error: Option<String>,
}
fn operation_dir(id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Move operation ID must be a UUID")?;
    let directory = security::directory()?.join(id);
    std::fs::create_dir_all(&directory).map_err(|_| "Move record storage unavailable")?;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let meta =
        std::fs::symlink_metadata(&directory).map_err(|_| "Move record storage unavailable")?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
        return Err("Unsafe move record directory".into());
    }
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "Move record permissions unavailable")?;
    Ok(directory)
}
fn read(id: &str) -> Result<MoveRecord, String> {
    security::read_json(&operation_dir(id)?.join("move.json"))
}
fn save(record: &MoveRecord) -> Result<(), String> {
    security::save_json(
        &operation_dir(&record.operation_id)?.join("move.json"),
        record,
    )
}
fn state(record: &mut MoveRecord, value: &str, progress: &str) -> Result<(), String> {
    record.state = value.into();
    record.progress = progress.into();
    record.error = None;
    save(record)
}
fn cancelled(id: &str) -> bool {
    operation_dir(id)
        .map(|dir| dir.join("cancel.json").exists())
        .unwrap_or(true)
}
fn active(state: &str) -> bool {
    !matches!(state, "completed" | "cancelled" | "failed")
}
pub fn pane_locked(pane: &str) -> bool {
    if records().into_iter().any(|record| {
        record.source.pane_id == pane && !record.paused.is_empty() && active(&record.state)
    }) {
        return true;
    }
    let Some(root) = crate::config::config_dir() else {
        return true;
    };
    let Ok(entries) = std::fs::read_dir(root.join("operations")) else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        let path = entry.path();
        let Ok(launch) = security::read_json::<Value>(&path.join("move-launch.json")) else {
            return false;
        };
        if launch["pane_id"] != pane
            && !tmux(&["display-message", "-p", "-t", pane, "#{session_name}"])
                .is_ok_and(|name| launch["tmux_session"] == name)
        {
            return false;
        }
        if security::read_json::<Value>(&path.join("move-committed.json"))
            .ok()
            .is_some_and(|commit| commit["committed"] == true)
        {
            return false;
        }
        !security::read_json::<Value>(&path.join("move-aborted.json"))
            .ok()
            .is_some_and(|abort| abort["state"] == "stopped")
    })
}
pub(crate) fn retiring_pane(pane: &str) -> bool {
    records().into_iter().any(|record| {
        record.source.pane_id == pane
            && matches!(record.state.as_str(), "retiring" | "completed")
            && tmux(&["display-message", "-p", "-t", pane, "#{pane_pid}"])
                .is_ok_and(|pid| pid == record.source.pane_pid)
    })
}
fn records() -> Vec<MoveRecord> {
    let Ok(directory) = security::directory() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter_map(|id| read(&id).ok())
        .collect()
}
fn tmux(args: &[&str]) -> Result<String, String> {
    let output = Command::new("tmux")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "tmux is unavailable")?;
    if !output.status.success() {
        return Err("tmux execution is unavailable".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}
fn source(pane: &str, expected: Option<&str>, ctx: &JobContext) -> Result<Source, String> {
    if !pane.starts_with('%') || pane[1..].parse::<u32>().is_err() {
        return Err("Invalid source pane".into());
    }
    let pane_pid = tmux(&["display-message", "-p", "-t", pane, "#{pane_pid}"])?;
    if tmux(&[
        "show-options",
        "-p",
        "-v",
        "-t",
        pane,
        "@clawtab-move-restricted",
    ])
    .is_ok_and(|value| value == "1")
    {
        return Err("Policy-bound and externally triggered runs cannot move until target enforcement and result routing are supported".into());
    }
    let cwd = tmux(&["display-message", "-p", "-t", pane, "#{pane_current_path}"])?;
    let snapshot = ProcessSnapshot::capture();
    let provider = agent_session::detect_process_provider(&pane_pid, Some(&snapshot))
        .ok_or("No supported agent in this pane")?;
    if !matches!(provider, ProcessProvider::Claude | ProcessProvider::Codex) {
        return Err("Move currently supports Claude and dedicated Codex sessions. Other providers do not yet have a verified idle handoff".into());
    }
    if provider == ProcessProvider::Codex
        && !snapshot.process_tree_pids(&pane_pid).iter().any(|pid| {
            snapshot
                .command_for_pid(pid)
                .is_some_and(|command| command.contains("codex") && command.contains("--no-daemon"))
        })
    {
        return Err("This Codex session uses a shared server. Resume it with --no-daemon before moving so other conversations are not interrupted".into());
    }
    let info = agent_session::resolve_session_info_for_provider_with_cwd(
        &pane_pid,
        Some(provider),
        Some(&snapshot),
        Some(&cwd),
    );
    let session_id = info
        .session_id
        .ok_or("Conversation identity has not been discovered yet")?;
    let execution_id = super::execution_id(pane, &pane_pid, Some(&session_id))
        .ok_or("Execution identity unavailable")?;
    if expected.is_some_and(|expected| expected != execution_id) {
        return Err("Source execution changed; reopen Move".into());
    }
    if !crate::agent_hooks::integration_statuses()
        .iter()
        .any(|status| status.provider == provider && status.configured && !status.needs_repair)
    {
        return Err("Enable this provider's ClawTab lifecycle hooks before moving".into());
    }
    let job_names: Vec<String> = ctx
        .job_status
        .lock()
        .iter()
        .filter_map(|(name, status)| match status {
            crate::config::jobs::JobStatus::Running {
                pane_id: Some(id), ..
            } if id == pane => Some(name.clone()),
            _ => None,
        })
        .collect();
    let secret_keys = crate::config::jobs::JobsConfig::load()
        .jobs
        .into_iter()
        .filter(|job| job_names.contains(&job.slug))
        .flat_map(|job| job.secret_keys)
        .collect();
    Ok(Source {
        pane_id: pane.into(),
        execution_id,
        pane_pid,
        cwd,
        provider,
        session_id,
        model: info.model_id,
        effort: info.agent_effort,
        secret_keys,
    })
}
fn worker_sync(request: Value, secrets: Vec<(String, String)>) -> Result<Value, String> {
    let script = format!(
        "TRANSFER_SOURCE = {}\n{}",
        serde_json::to_string(include_str!("transfer.py")).map_err(|_| "Invalid worker source")?,
        include_str!("movement/worker.py")
    );
    let mut command = Command::new("python3");
    command
        .args(["-c", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command.envs(secrets);
    let mut child = command
        .spawn()
        .map_err(|_| "Python 3 is required for Move")?;
    let bytes = serde_json::to_vec(&request).map_err(|_| "Invalid move worker request")?;
    child
        .stdin
        .take()
        .ok_or("Move worker input unavailable")?
        .write_all(&bytes)
        .map_err(|_| "Move worker input unavailable")?;
    let output = child.wait_with_output().map_err(|_| "Move worker failed")?;
    let result: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Move worker returned an invalid result")?;
    if let Some(error) = result["error"].as_str() {
        return Err(error.into());
    }
    if !output.status.success() {
        return Err("Move worker failed".into());
    }
    Ok(result["result"].clone())
}
async fn worker(request: Value) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || worker_sync(request, Vec::new()))
        .await
        .map_err(|_| "Move worker stopped")?
}
async fn read_chunk(id: &str, offset: u64, size: u64) -> Result<Value, String> {
    let path = crate::config::config_dir()
        .ok_or("Configuration unavailable")?
        .join("operations")
        .join(id)
        .join("payload.zip");
    tokio::task::spawn_blocking(move || {
        use std::{io::{Read, Seek, SeekFrom}, os::unix::fs::OpenOptionsExt};
        let mut file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).map_err(|_| "Source archive unavailable")?;
        if offset >= size || file.metadata().map_err(|_| "Source archive unavailable")?.len() != size { return Err("Source archive changed".into()); }
        file.seek(SeekFrom::Start(offset)).map_err(|_| "Source archive unavailable")?;
        let mut bytes = vec![0; ((size - offset).min(32 * 1024)) as usize];
        file.read_exact(&mut bytes).map_err(|_| "Source archive unavailable")?;
        Ok(json!({"data":base64::engine::general_purpose::STANDARD.encode(&bytes),"offset":offset + bytes.len() as u64}))
    }).await.map_err(|_| "Source archive reader stopped")?
}
fn worker_source(source: &Source, action: &str) -> Value {
    json!({"action":action,"provider":source.provider.as_str(),"session_id":source.session_id,"cwd":source.cwd,"model":source.model,"effort":source.effort})
}
async fn preflight(
    source: &Source,
    target: &str,
    destination: &str,
    ctx: &JobContext,
) -> Result<Value, String> {
    if !security::enabled() {
        return Err(
            "Verify client and machine keys, then enable secure commands on both machines".into(),
        );
    }
    let owner = security::machine_id()?;
    uuid::Uuid::parse_str(target).map_err(|_| "Invalid destination machine")?;
    if owner == target {
        return Err("Choose another machine".into());
    }
    Identity::load()?;
    security::trusted_machine(target)?;
    let facts = worker(worker_source(source, "source_info")).await?;
    let target_status = peer::request(ctx, target, json!({"action":"preflight","provider":source.provider.as_str(),"provider_version":facts["provider_version"],"auth_provider":facts["auth_provider"],"required_tools":facts["required_tools"],"destination":destination,"secret_keys":source.secret_keys})).await?;
    Ok(
        json!({"source":source,"files":facts["files"],"excluded":facts["excluded"],"required_tools":facts["required_tools"],"target":target_status,"target_machine":target,"encryption":"end_to_end","secrets":"target_only"}),
    )
}

pub async fn execute(request: HostRequest, ctx: &JobContext) -> Result<Value, String> {
    match request {
        HostRequest::MoveTargets => {
            let mut roster = peer::roster(ctx).await?;
            if let Some(machines) = roster["machines"].as_array_mut() {
                for machine in machines {
                    machine["verified"] = json!(machine["id"]
                        .as_str()
                        .is_some_and(|id| security::trusted_machine(id).is_ok()));
                }
            }
            Ok(roster)
        }
        HostRequest::MoveSource { pane_id } => serde_json::to_value(source(&pane_id, None, ctx)?)
            .map_err(|_| "Invalid source metadata".into()),
        HostRequest::MovePreflight {
            pane_id,
            execution_id,
            target,
            destination,
        } => {
            let source = source(&pane_id, Some(&execution_id), ctx)?;
            preflight(&source, &target, &destination, ctx).await
        }
        HostRequest::MoveStart {
            operation_id,
            pane_id,
            execution_id,
            target,
            destination,
            setup,
        } => {
            uuid::Uuid::parse_str(&operation_id).map_err(|_| "Invalid move ID")?;
            if let Ok(existing) = read(&operation_id) {
                if existing.source.pane_id != pane_id
                    || existing.source.execution_id != execution_id
                    || existing.target != target
                    || existing.destination != destination
                    || existing.setup != setup
                {
                    return Err("Move ID already belongs to another request".into());
                }
                return serde_json::to_value(existing).map_err(|_| "Invalid move record".into());
            }
            let source = source(&pane_id, Some(&execution_id), ctx)?;
            let preview = preflight(&source, &target, &destination, ctx).await?;
            if preview["target"]["needs_setup"] == true && !setup {
                return Err("Project setup needs separate confirmation".into());
            }
            let record = MoveRecord {
                created_at: chrono::Utc::now().timestamp_millis(),
                operation_id,
                source,
                target,
                destination,
                setup,
                state: "waiting_for_idle".into(),
                progress: "Waiting for the current turn and tools to finish".into(),
                paused: Vec::new(),
                manifest: None,
                remote: None,
                error: None,
            };
            {
                let _lock = RECORD_LOCK.lock();
                if records()
                    .iter()
                    .any(|r| active(&r.state) && r.source.pane_id == pane_id)
                {
                    return Err("This source already has a move in progress".into());
                }
                save(&record)?;
            }
            start(record.clone(), ctx.clone());
            serde_json::to_value(record).map_err(|_| "Invalid move record".into())
        }
        HostRequest::MoveStatus {
            operation_id,
            pane_id,
        } => {
            if let Some(id) = operation_id {
                return serde_json::to_value(read(&id)?).map_err(|_| "Invalid move record".into());
            }
            let mut matching: Vec<MoveRecord> = records()
                .into_iter()
                .filter(|record| {
                    pane_id
                        .as_ref()
                        .is_none_or(|pane| pane == &record.source.pane_id)
                })
                .collect();
            matching.sort_by_key(|record| {
                (!active(&record.state), std::cmp::Reverse(record.created_at))
            });
            Ok(json!({"moves":matching}))
        }
        HostRequest::MoveCancel { operation_id } => {
            let _lock = RECORD_LOCK.lock();
            let record = read(&operation_id)?;
            if !active(&record.state) {
                return Err("This move has already finished".into());
            }
            if matches!(
                record.state.as_str(),
                "activating" | "verifying" | "retiring" | "stopping_setup" | "needs_recovery"
            ) {
                return Err("Remote activation may have occurred; use Check handoff before recovering the source".into());
            }
            security::save_json(
                &operation_dir(&operation_id)?.join("cancel.json"),
                &json!({"cancel":true}),
            )?;
            if !RUNNING.lock().contains(&operation_id) {
                start(record, ctx.clone());
            }
            Ok(json!({"cancellation_requested":true}))
        }
        HostRequest::MoveRecover { operation_id } => {
            let record = read(&operation_id)?;
            if RUNNING.lock().contains(&operation_id) {
                return Ok(json!({"running":true}));
            }
            if !active(&record.state) {
                return serde_json::to_value(record).map_err(|_| "Invalid move record".into());
            }
            start(record, ctx.clone());
            Ok(json!({"recovery_started":true}))
        }
        HostRequest::MoveRollback { operation_id } => {
            let mut record = read(&operation_id)?;
            if record.state != "needs_recovery"
                || !super::validate_execution(&record.source.pane_id, &record.source.execution_id)
            {
                return Err("The paused source cannot be safely restored automatically".into());
            }
            if !RUNNING.lock().insert(operation_id.clone()) {
                return Err("A handoff check is running; wait for its result".into());
            }
            let _guard = RunningGuard(operation_id);
            peer::request(
                ctx,
                &record.target,
                json!({"action":"abort","operation_id":record.operation_id}),
            )
            .await?;
            restore(&record)?;
            state(
                &mut record,
                "cancelled",
                "Remote execution stopped; original agent restored",
            )?;
            let _ = worker(json!({"action":"cleanup","operation_id":record.operation_id})).await;
            let _ = peer::request(
                ctx,
                &record.target,
                json!({"action":"cleanup","operation_id":record.operation_id}),
            )
            .await;
            serde_json::to_value(record).map_err(|_| "Invalid move record".into())
        }
        other => super::execute(other).await,
    }
}

struct RunningGuard(String);
impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.lock().remove(&self.0);
    }
}
fn start(mut record: MoveRecord, ctx: JobContext) {
    if !RUNNING.lock().insert(record.operation_id.clone()) {
        return;
    }
    tokio::spawn(async move {
        let _guard = RunningGuard(record.operation_id.clone());
        if let Err(error) = run_move(&mut record, &ctx).await {
            let setup_unresolved = record.setup
                && !record.paused.is_empty()
                && peer::request(
                    &ctx,
                    &record.target,
                    json!({"action":"stop_setup","operation_id":record.operation_id}),
                )
                .await
                .is_err();
            let activation_possible = setup_unresolved
                || matches!(
                    record.state.as_str(),
                    "activating" | "verifying" | "retiring" | "stopping_setup" | "needs_recovery"
                );
            if activation_possible {
                record.state = "needs_recovery".into();
                record.progress = "Source is paused. Check the remote handoff before resuming either conversation".into();
            } else {
                match restore(&record) {
                    Ok(()) => {
                        record.state = if cancelled(&record.operation_id) {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .into();
                        record.progress = "Original agent restored".into();
                        let _ =
                            worker(json!({"action":"cleanup","operation_id":record.operation_id}))
                                .await;
                        let _ = peer::request(
                            &ctx,
                            &record.target,
                            json!({"action":"cleanup","operation_id":record.operation_id}),
                        )
                        .await;
                    }
                    Err(_) => {
                        record.state = "needs_recovery".into();
                        record.progress =
                            "Original execution could not be safely restored; inspect the source"
                                .into();
                    }
                }
            }
            record.error = Some(error);
            let _ = save(&record);
        }
    });
}
pub fn recover_pending(ctx: JobContext) {
    for record in records().into_iter().filter(|record| active(&record.state)) {
        start(record, ctx.clone());
    }
}

fn process_matches(process: &PausedProcess, snapshot: &ProcessSnapshot) -> bool {
    snapshot.start_epoch_for_pid(&process.pid) == Some(process.started)
        && snapshot
            .command_for_pid(&process.pid)
            .is_some_and(|command| command_hash(command) == process.command_hash)
}
fn command_hash(command: &str) -> String {
    Sha256::digest(command.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn signal(process: &PausedProcess, value: i32) -> Result<(), String> {
    let snapshot = ProcessSnapshot::capture();
    if !process_matches(process, &snapshot) {
        return Err("Source process identity changed; refusing to signal it".into());
    }
    let pid: i32 = process
        .pid
        .parse()
        .map_err(|_| "Invalid source process ID")?;
    if pid <= 1 || unsafe { libc::kill(pid, value) } != 0 {
        return Err("Could not signal the source process safely".into());
    }
    Ok(())
}
fn freeze(record: &mut MoveRecord) -> Result<(), String> {
    if !record.paused.is_empty() {
        for process in &record.paused {
            if !process.already_stopped {
                signal(process, libc::SIGSTOP)?;
            }
        }
        return Ok(());
    }
    let snapshot = ProcessSnapshot::capture();
    let pids = snapshot.process_tree_pids(&record.source.pane_pid);
    let mut processes = Vec::new();
    for pid in pids {
        let started = snapshot
            .start_epoch_for_pid(&pid)
            .ok_or("Source process start time unavailable")?;
        let command = snapshot
            .command_for_pid(&pid)
            .ok_or("Source process command unavailable")?;
        let status = Command::new("ps")
            .args(["-p", &pid, "-o", "state="])
            .output()
            .map_err(|_| "Source process state unavailable")?;
        if !status.status.success() {
            return Err("Source process exited before capture".into());
        }
        processes.push(PausedProcess {
            pid,
            started,
            command_hash: command_hash(command),
            already_stopped: String::from_utf8_lossy(&status.stdout)
                .trim()
                .starts_with('T'),
        });
    }
    processes.sort_by_key(|process| process.pid != record.source.pane_pid);
    record.paused = processes;
    save(record)?;
    for process in &record.paused {
        if !process.already_stopped {
            signal(process, libc::SIGSTOP)?;
        }
    }
    // A child spawned between discovery and stopping must not escape the snapshot boundary.
    let after = ProcessSnapshot::capture().process_tree_pids(&record.source.pane_pid);
    if after
        != record
            .paused
            .iter()
            .map(|process| process.pid.clone())
            .collect()
    {
        return Err("Source process tree changed during quiescence; retry Move".into());
    }
    Ok(())
}
fn restore(record: &MoveRecord) -> Result<(), String> {
    if record.paused.is_empty() {
        return Ok(());
    }
    if !super::validate_execution(&record.source.pane_id, &record.source.execution_id) {
        return Err("Original execution has changed".into());
    }
    let snapshot = ProcessSnapshot::capture();
    for process in record
        .paused
        .iter()
        .rev()
        .filter(|process| !process.already_stopped)
    {
        if snapshot.command_for_pid(&process.pid).is_some() {
            signal(process, libc::SIGCONT)?;
        }
    }
    Ok(())
}
fn retire(record: &MoveRecord) -> Result<(), String> {
    // The durable freeze record owns these exact process identities. On retry,
    // some children may already be gone, so session discovery is no longer a
    // reliable test of whether the remaining original processes should stop.
    let same_pane = tmux(&[
        "display-message",
        "-p",
        "-t",
        &record.source.pane_id,
        "#{pane_pid}",
    ])
    .is_ok_and(|pid| pid == record.source.pane_pid);
    if same_pane {
        let _ = tmux(&[
            "set-option",
            "-p",
            "-t",
            &record.source.pane_id,
            "remain-on-exit",
            "on",
        ]);
        let notice = format!(
            "Moved to {}. Open the remote conversation in ClawTab.",
            record.target
        );
        let _ = tmux(&[
            "set-option",
            "-p",
            "-t",
            &record.source.pane_id,
            "remain-on-exit-format",
            &notice,
        ]);
    }
    for process in record.paused.iter().rev() {
        if process_matches(process, &ProcessSnapshot::capture()) {
            // The snapshot was captured at an idle boundary. Do not unfreeze a process
            // to terminate it: queued terminal input could start another turn.
            signal(process, libc::SIGKILL)?;
        }
    }
    Ok(())
}
async fn complete(record: &mut MoveRecord, ctx: &JobContext) -> Result<(), String> {
    state(
        record,
        "retiring",
        "Remote verified; stopping the original execution",
    )?;
    retire(record)?;
    for _ in 0..50 {
        let snapshot = ProcessSnapshot::capture();
        if !record
            .paused
            .iter()
            .any(|process| process_matches(process, &snapshot))
        {
            peer::request(
                ctx,
                &record.target,
                json!({"action":"commit","operation_id":record.operation_id}),
            )
            .await?;
            state(
                record,
                "completed",
                "Moved successfully. The remote is waiting for your next message",
            )?;
            let notice = format!(
                "Moved to machine {}. Remote conversation is waiting for your next message.",
                record.target
            );
            let _ = tmux(&[
                "set-option",
                "-p",
                "-t",
                &record.source.pane_id,
                "@clawtab-moved",
                &record.target,
            ]);
            let _ = tmux(&["display-message", "-t", &record.source.pane_id, &notice]);
            let _ = worker(json!({"action":"cleanup","operation_id":record.operation_id})).await;
            let _ = peer::request(
                ctx,
                &record.target,
                json!({"action":"cleanup","operation_id":record.operation_id}),
            )
            .await;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("Original execution has not stopped; check the handoff again".into())
}

async fn run_move(record: &mut MoveRecord, ctx: &JobContext) -> Result<(), String> {
    for _ in 0..30 {
        if ctx.relay.lock().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if matches!(
        record.state.as_str(),
        "activating" | "verifying" | "retiring" | "stopping_setup" | "needs_recovery"
    ) {
        if record.setup {
            peer::request(
                ctx,
                &record.target,
                json!({"action":"stop_setup","operation_id":record.operation_id}),
            )
            .await?;
        }
        let remote = peer::request(
            ctx,
            &record.target,
            json!({"action":"status","operation_id":record.operation_id}),
        )
        .await?;
        if remote["state"] == "ready" {
            record.remote = Some(remote);
            return complete(record, ctx).await;
        }
        if remote["state"] == "absent" {
            // Absence alone cannot rule out a delayed launch frame. Commit an
            // abort barrier on the target before the original can run again.
            peer::request(
                ctx,
                &record.target,
                json!({"action":"abort","operation_id":record.operation_id}),
            )
            .await?;
            restore(record)?;
            return state(
                record,
                "failed",
                "Remote activation did not occur; original agent restored",
            );
        }
        return Err(
            "Remote activation is unresolved; inspect the target terminal and check again".into(),
        );
    }
    while record.paused.is_empty() {
        if cancelled(&record.operation_id) {
            return Err("Move cancelled".into());
        }
        let current = source(
            &record.source.pane_id,
            Some(&record.source.execution_id),
            ctx,
        )?;
        if current != record.source {
            return Err("Source conversation or configuration changed; reopen Move".into());
        }
        if ctx
            .hook_runtime
            .pane_state(&record.source.pane_id, record.source.provider)
            .is_some_and(|state| {
                state.state == crate::agent_hooks::HookAgentState::Idle
                    && state.session_id == record.source.session_id
            })
        {
            let preview =
                preflight(&record.source, &record.target, &record.destination, ctx).await?;
            if preview["target"]["needs_setup"] == true && !record.setup {
                return Err("Target now needs setup; reopen Move to confirm it".into());
            }
            if !ctx
                .hook_runtime
                .pane_state(&record.source.pane_id, record.source.provider)
                .is_some_and(|state| {
                    state.state == crate::agent_hooks::HookAgentState::Idle
                        && state.session_id == record.source.session_id
                })
            {
                continue;
            }
            source(
                &record.source.pane_id,
                Some(&record.source.execution_id),
                ctx,
            )?;
            freeze(record)?;
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    // A crash can occur after persisting the freeze intent and before SIGSTOP.
    freeze(record)?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    if !ctx
        .hook_runtime
        .pane_state(&record.source.pane_id, record.source.provider)
        .is_some_and(|state| {
            state.state == crate::agent_hooks::HookAgentState::Idle
                && state.session_id == record.source.session_id
        })
    {
        return Err("Source became busy while pausing; retry Move after the turn finishes".into());
    }
    if cancelled(&record.operation_id) {
        return Err("Move cancelled".into());
    }
    state(
        record,
        "capturing",
        "Capturing repository changes and the selected conversation",
    )?;
    if record.manifest.is_none() {
        let mut request = worker_source(&record.source, "prepare");
        request["operation_id"] = json!(record.operation_id);
        record.manifest = Some(worker(request).await?);
        save(record)?;
    }
    let manifest = record
        .manifest
        .as_ref()
        .ok_or("Move snapshot unavailable")?
        .clone();
    state(
        record,
        "transferring",
        "Sending the encrypted snapshot to the target",
    )?;
    let begin = peer::request(ctx, &record.target, json!({"action":"transfer_begin","operation_id":record.operation_id,"path":record.destination,"size":manifest["size"],"sha256":manifest["sha256"]})).await?;
    let mut offset = begin["offset"]
        .as_u64()
        .ok_or("Invalid target transfer offset")?;
    let size = manifest["size"].as_u64().ok_or("Invalid snapshot size")?;
    while offset < size {
        if cancelled(&record.operation_id) {
            return Err("Move cancelled".into());
        }
        let chunk = read_chunk(&record.operation_id, offset, size).await?;
        let next = chunk["offset"].as_u64().ok_or("Invalid source offset")?;
        if next <= offset || next > size {
            return Err("Invalid snapshot chunk".into());
        }
        let reply = peer::request(ctx, &record.target, json!({"action":"transfer_write","operation_id":record.operation_id,"offset":offset,"data":chunk["data"]})).await?;
        if reply["offset"].as_u64() != Some(next) {
            return Err("Target acknowledged an invalid offset".into());
        }
        offset = next;
        record.progress = format!(
            "Sending encrypted snapshot: {}%",
            offset.saturating_mul(100) / size
        );
        save(record)?;
    }
    state(
        record,
        "importing",
        "Restoring repository and conversation into a fresh target worktree",
    )?;
    peer::request(
        ctx,
        &record.target,
        json!({"action":"import","operation_id":record.operation_id}),
    )
    .await?;
    if record.setup {
        state(
            record,
            "setting_up",
            "Remote setup is running. Review its terminal if it asks for approval",
        )?;
        let setup = peer::request(ctx, &record.target, json!({"action":"launch","operation_id":record.operation_id,"setup":true,"secret_keys":record.source.secret_keys})).await?;
        record.remote = Some(setup);
        save(record)?;
        loop {
            if cancelled(&record.operation_id) {
                state(
                    record,
                    "stopping_setup",
                    "Stopping remote setup before restoring the source",
                )?;
                peer::request(
                    ctx,
                    &record.target,
                    json!({"action":"stop_setup","operation_id":record.operation_id}),
                )
                .await?;
                state(record, "setting_up", "Remote setup stopped")?;
                return Err("Move cancelled during setup".into());
            }
            let result = peer::request(
                ctx,
                &record.target,
                json!({"action":"setup_status","operation_id":record.operation_id}),
            )
            .await?;
            if result["complete"] == true {
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        state(
            record,
            "stopping_setup",
            "Stopping the completed setup conversation",
        )?;
        peer::request(
            ctx,
            &record.target,
            json!({"action":"stop_setup","operation_id":record.operation_id}),
        )
        .await?;
    }
    if cancelled(&record.operation_id) {
        return Err("Move cancelled before activation".into());
    }
    // Persist before launch: failure from here is ambiguous and may never auto-resume the source.
    {
        let _lock = RECORD_LOCK.lock();
        if cancelled(&record.operation_id) {
            return Err("Move cancelled before activation".into());
        }
        state(
            record,
            "activating",
            "Loading the existing conversation on the remote",
        )?;
    }
    record.remote = Some(peer::request(ctx, &record.target, json!({"action":"launch","operation_id":record.operation_id,"setup":false,"secret_keys":record.source.secret_keys})).await?);
    state(
        record,
        "verifying",
        "Verifying remote conversation identity and idle readiness",
    )?;
    for _ in 0..60 {
        let status = peer::request(
            ctx,
            &record.target,
            json!({"action":"status","operation_id":record.operation_id}),
        )
        .await?;
        if status["state"] == "ready" {
            record.remote = Some(status);
            save(record)?;
            return complete(record, ctx).await;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err("Remote conversation has not confirmed readiness; source remains paused".into())
}

pub async fn receive_peer(value: &Value, ctx: &JobContext) -> Result<(), String> {
    peer::receive(value, ctx).await
}
async fn peer_execute(sender: &str, request: Value, ctx: &JobContext) -> Result<Value, String> {
    security::trusted_machine(sender)?;
    let action = request["action"].as_str().ok_or("Invalid peer action")?;
    if action == "preflight" {
        let secrets = check_secrets(&request, ctx)?;
        let provider = request["provider"]
            .as_str()
            .and_then(ProcessProvider::from_name)
            .ok_or("Invalid provider")?;
        if !matches!(provider, ProcessProvider::Claude | ProcessProvider::Codex) {
            return Err("This provider does not yet have a verified idle handoff".into());
        }
        if !crate::agent_hooks::integration_statuses()
            .iter()
            .any(|status| status.provider == provider && status.configured && !status.needs_repair)
        {
            return Err("Enable the provider's lifecycle hooks on the target first".into());
        }
        return tokio::task::spawn_blocking(move || worker_sync(request, secrets))
            .await
            .map_err(|_| "Target preflight stopped")?;
    }
    if !matches!(
        action,
        "transfer_begin"
            | "transfer_write"
            | "import"
            | "launch"
            | "status"
            | "setup_status"
            | "stop_setup"
            | "cleanup"
            | "abort"
            | "commit"
    ) {
        return Err("Unsupported secure peer operation".into());
    }
    let id = request["operation_id"].as_str().ok_or("Move ID missing")?;
    let directory = operation_dir(id)?;
    let owner_path = directory.join("receiver.json");
    {
        let _lock = RECORD_LOCK.lock();
        if owner_path.exists() {
            let saved: Value = security::read_json(&owner_path)?;
            if saved["source"] != sender {
                return Err("Move operation belongs to another source machine".into());
            }
        } else if action == "transfer_begin" {
            security::save_json(&owner_path, &json!({"source":sender}))?;
        } else if matches!(action, "status" | "stop_setup" | "cleanup") {
            return Ok(json!({"state":"absent"}));
        } else {
            return Err("Target move has not been accepted".into());
        }
    }
    if matches!(action, "abort" | "stop_setup") {
        let id = id.to_owned();
        let setup_only = action == "stop_setup";
        return tokio::task::spawn_blocking(move || stop_target(&id, setup_only))
            .await
            .map_err(|_| "Target recovery stopped")?;
    }
    if action == "commit" {
        let base = crate::config::config_dir()
            .ok_or("Configuration unavailable")?
            .join("operations")
            .join(id);
        if base.join("move-aborted.json").exists() {
            return Err("Remote execution was aborted; inspect the handoff".into());
        }
        security::save_json(
            &base.join("move-committed.json"),
            &json!({"committed":true}),
        )?;
        return Ok(json!({"committed":true}));
    }
    if matches!(action, "status" | "setup_status") {
        let base = crate::config::config_dir()
            .ok_or("Configuration unavailable")?
            .join("operations")
            .join(id);
        if base.join("move-aborted.json").exists() {
            let abort: Value = security::read_json(&base.join("move-aborted.json"))?;
            return Ok(
                json!({"state":if abort["state"] == "stopped" { "absent" } else { "aborting" }}),
            );
        }
        let launch = base.join(if action == "setup_status" {
            "setup-launch.json"
        } else {
            "move-launch.json"
        });
        if !launch.exists() {
            return Ok(json!({"state":"absent"}));
        }
        let mut launch: Value = security::read_json(&launch)?;
        let pane = launch["pane_id"]
            .as_str()
            .ok_or("Target launch acknowledgement is incomplete; inspect its tmux session")?
            .to_owned();
        let provider = launch["provider"]
            .as_str()
            .and_then(ProcessProvider::from_name)
            .ok_or("Invalid target provider")?;
        let pid = tmux(&["display-message", "-p", "-t", &pane, "#{pane_pid}"])?;
        if launch["pane_started"].as_i64() != ProcessSnapshot::capture().start_epoch_for_pid(&pid)
            || launch["pane_pid"] != pid
            || tmux(&["display-message", "-p", "-t", &pane, "#{session_name}"])?
                != launch["tmux_session"].as_str().unwrap_or_default()
        {
            return Err("Remote pane execution changed".into());
        }
        let cwd = launch["cwd"]
            .as_str()
            .ok_or("Target working directory unavailable")?;
        if tmux(&["display-message", "-p", "-t", &pane, "#{pane_current_path}"])? != cwd {
            return Err("Remote agent is in a different working directory".into());
        }
        let info = agent_session::resolve_session_info_for_provider_with_cwd_fast(
            &pid,
            Some(provider),
            Some(&ProcessSnapshot::capture()),
            Some(cwd),
        );
        let hook = ctx.hook_runtime.pane_state(&pane, provider);
        if action == "setup_status" {
            let launched = launch["launched_at"]
                .as_u64()
                .ok_or("Setup start time unavailable")?;
            let completed = hook.is_some_and(|hook| {
                hook.state == crate::agent_hooks::HookAgentState::Idle
                    && hook.updated_at_ms > launched
                    && hook.event == "stop"
            });
            return Ok(json!({"complete":completed}));
        }
        if info.session_id.as_deref() == launch["session_id"].as_str()
            && hook.is_some_and(|hook| {
                hook.state == crate::agent_hooks::HookAgentState::Idle
                    && Some(hook.session_id.as_str()) == launch["session_id"].as_str()
            })
        {
            launch["state"] = json!("ready");
            launch["execution_id"] =
                json!(super::execution_id(&pane, &pid, info.session_id.as_deref()));
        }
        return Ok(launch);
    }
    if action == "launch" {
        let secrets = check_secrets(&request, ctx)?;
        return tokio::task::spawn_blocking(move || worker_sync(request, secrets))
            .await
            .map_err(|_| "Target launch worker stopped")?;
    }
    worker(request).await
}
fn check_secrets(request: &Value, ctx: &JobContext) -> Result<Vec<(String, String)>, String> {
    let keys: Vec<String> =
        serde_json::from_value(request.get("secret_keys").cloned().unwrap_or(json!([])))
            .map_err(|_| "Invalid secret requirements")?;
    if keys.len() > 100
        || keys.iter().any(|key| {
            key.is_empty()
                || key.len() > 128
                || !key
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_')
        })
    {
        return Err("Invalid secret requirements".into());
    }
    let reserved = [
        "HOME",
        "PATH",
        "SHELL",
        "TMPDIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "PYTHONPATH",
        "PYTHONHOME",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
    ];
    if keys.iter().any(|key| reserved.contains(&key.as_str())) {
        return Err(
            "Move cannot inject secrets that override runtime paths or loader settings".into(),
        );
    }
    let secrets = ctx.secrets.lock();
    keys.into_iter()
        .map(|key| {
            secrets
                .get(&key)
                .cloned()
                .map(|value| (key, value))
                .ok_or("A required secret must be configured on the target first".into())
        })
        .collect()
}

fn stop_target(id: &str, setup_only: bool) -> Result<Value, String> {
    use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
    let directory = crate::config::config_dir()
        .ok_or("Configuration unavailable")?
        .join("operations")
        .join(id);
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join("move-worker.lock"))
        .map_err(|_| "Target recovery lock unavailable")?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err("Target recovery lock unavailable".into());
    }
    let marker = directory.join(if setup_only {
        "setup-stopped.json"
    } else {
        "move-aborted.json"
    });
    let mut roots: Vec<String> = Vec::new();
    let mut processes: Vec<PausedProcess> = if marker.exists() {
        let saved: Value = security::read_json(&marker)?;
        if saved["state"] == "stopped" {
            return Ok(json!({"state":"absent"}));
        }
        roots = serde_json::from_value(saved["roots"].clone())
            .map_err(|_| "Invalid target recovery roots")?;
        serde_json::from_value(saved["processes"].clone())
            .map_err(|_| "Invalid target recovery record")?
    } else {
        let mut processes = Vec::new();
        let files: &[&str] = if setup_only {
            &["setup-launch.json"]
        } else {
            &["setup-launch.json", "move-launch.json"]
        };
        for file in files {
            let path = directory.join(file);
            match path.try_exists() {
                Ok(false) => continue,
                Err(_) => return Err("Target launch record unavailable".into()),
                Ok(true) => {}
            }
            let launch: Value = security::read_json(&path)?;
            let pane = launch["pane_id"]
                .as_str()
                .ok_or("Target launch is ambiguous; inspect its tmux session before recovery")?;
            let expected_pid = launch["pane_pid"]
                .as_str()
                .ok_or("Target process identity unavailable")?;
            let snapshot = ProcessSnapshot::capture();
            if snapshot.command_for_pid(expected_pid).is_none() {
                continue;
            }
            let expected_start = launch["pane_started"]
                .as_i64()
                .ok_or("Target process start identity unavailable")?;
            if snapshot.start_epoch_for_pid(expected_pid) != Some(expected_start) {
                return Err(
                    "Target process identity changed; refusing to stop a reused PID".into(),
                );
            }
            if tmux(&["display-message", "-p", "-t", pane, "#{pane_pid}"])? != expected_pid
                || tmux(&["display-message", "-p", "-t", pane, "#{session_name}"])?
                    != launch["tmux_session"].as_str().unwrap_or_default()
            {
                return Err("Target execution changed; refusing to stop it".into());
            }
            roots.push(expected_pid.into());
            for pid in snapshot.process_tree_pids(expected_pid) {
                processes.push(PausedProcess {
                    started: snapshot
                        .start_epoch_for_pid(&pid)
                        .ok_or("Target process start unavailable")?,
                    command_hash: command_hash(
                        snapshot
                            .command_for_pid(&pid)
                            .ok_or("Target process command unavailable")?,
                    ),
                    already_stopped: false,
                    pid,
                });
            }
        }
        processes
    };
    processes.sort_by_key(|process| !roots.contains(&process.pid));
    let mut seen = HashSet::new();
    processes.retain(|process| seen.insert(process.pid.clone()));
    loop {
        security::save_json(
            &marker,
            &json!({"state":"stopping","processes":processes,"roots":roots}),
        )?;
        for process in &processes {
            if process_matches(process, &ProcessSnapshot::capture()) {
                signal(process, libc::SIGSTOP)?;
            }
        }
        let snapshot = ProcessSnapshot::capture();
        let known: HashSet<String> = processes
            .iter()
            .map(|process| process.pid.clone())
            .collect();
        let additional: HashSet<String> = roots
            .iter()
            .filter(|root| {
                processes
                    .iter()
                    .any(|process| &process.pid == *root && process_matches(process, &snapshot))
            })
            .flat_map(|root| snapshot.process_tree_pids(root))
            .filter(|pid| !known.contains(pid))
            .collect();
        if additional.is_empty() {
            break;
        }
        if processes.len() + additional.len() > 1024 {
            return Err("Target process tree exceeds recovery limit; source remains paused".into());
        }
        for pid in additional {
            processes.push(PausedProcess {
                started: snapshot
                    .start_epoch_for_pid(&pid)
                    .ok_or("Target process start unavailable")?,
                command_hash: command_hash(
                    snapshot
                        .command_for_pid(&pid)
                        .ok_or("Target process command unavailable")?,
                ),
                already_stopped: false,
                pid,
            });
        }
    }
    for process in processes.iter().rev() {
        if process_matches(process, &ProcessSnapshot::capture()) {
            signal(process, libc::SIGKILL)?;
        }
    }
    for _ in 0..50 {
        if !processes
            .iter()
            .any(|process| process_matches(process, &ProcessSnapshot::capture()))
        {
            security::save_json(
                &marker,
                &json!({"state":"stopped","processes":processes,"roots":roots}),
            )?;
            return Ok(json!({"state":"absent"}));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("Target execution has not stopped; source remains paused".into())
}
