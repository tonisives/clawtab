use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use clawtab_protocol::DetectedProcess;

use crate::config::jobs::{JobStatus, JobsConfig};
use crate::pty::SharedPtyManager;

pub async fn detect_processes_snapshot(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    pty_manager: &SharedPtyManager,
) -> Vec<DetectedProcess> {
    let jc = Arc::clone(jobs_config);
    let js = Arc::clone(job_status);
    let live_viewer_panes = pty_manager.lock().active_pane_ids();
    let processes =
        tokio::task::spawn_blocking(move || detect_processes(&jc, &js, live_viewer_panes))
            .await
            .unwrap_or_default();
    log::info!("DetectProcesses: returning {} processes", processes.len());
    for p in &processes {
        log::info!(
            "  - pane={} provider={} cmd_version={} session={} window={} group={:?} job={:?} cwd={}",
            p.pane_id, p.provider, p.version, p.tmux_session, p.window_name,
            p.matched_group, p.matched_job, p.cwd
        );
    }
    processes
}

fn detect_processes(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    live_viewer_panes: HashSet<String>,
) -> Vec<DetectedProcess> {
    let Some(stdout) = list_panes() else {
        return vec![];
    };
    let pane_lines = stdout.lines().count();
    if pane_lines > 0 {
        let first = stdout.lines().next().unwrap_or("");
        let hex: String = first
            .bytes()
            .take(80)
            .map(|b| format!("{:02x} ", b))
            .collect();
        log::info!(
            "detect_processes: tmux returned {} pane lines. first_line_hex(80)={}",
            pane_lines,
            hex
        );
    } else {
        log::info!("detect_processes: tmux returned 0 pane lines");
    }

    let running_panes = collect_running_panes(jobs_config, job_status);
    let slug_to_group = collect_slug_to_group(jobs_config);
    let match_entries = collect_match_entries(jobs_config);

    let mut seen = HashSet::new();
    let mut results = Vec::new();
    let mut counters = SkipCounters::default();

    for line in stdout.lines() {
        let Some(row) = parse_row(line) else {
            counters.short += 1;
            continue;
        };
        if is_view_session(row.session) {
            counters.view += 1;
            continue;
        }
        if row.window == "__placeholder" {
            counters.placeholder += 1;
            continue;
        }
        let Some(provider) = resolve_provider(&row) else {
            continue;
        };
        if !seen.insert(row.pane_id.to_string()) {
            continue;
        }
        let (matched_group, matched_job) =
            resolve_group_job(&row, &running_panes, &slug_to_group, &match_entries);
        results.push(build_remote(
            &row,
            provider,
            matched_group,
            matched_job,
            &live_viewer_panes,
        ));
    }

    log::info!(
        "detect_processes: summary: total_lines={} skipped_short={} skipped_view={} skipped_placeholder={} kept={}",
        pane_lines, counters.short, counters.view, counters.placeholder, results.len()
    );

    results
}

fn list_panes() -> Option<String> {
    let output = crate::debug_spawn::run_logged(
        "tmux",
        &[
            "list-panes", "-a", "-F",
            "#{pane_id}\x1e#{pane_current_command}\x1e#{pane_current_path}\x1e#{session_name}\x1e#{window_name}\x1e#{pane_pid}\x1e#{window_id}\x1e#{pane_title}\x1e#{@clawtab-slug}",
        ],
        "process_snapshot::list_panes",
    );
    match output {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).to_string()),
        Ok(o) => {
            log::warn!(
                "detect_processes: tmux list-panes exited {:?}: stderr={}",
                o.status.code(),
                String::from_utf8_lossy(&o.stderr)
            );
            None
        }
        Err(e) => {
            log::warn!("detect_processes: tmux list-panes spawn error: {}", e);
            None
        }
    }
}

fn collect_running_panes(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) -> HashMap<String, (String, String)> {
    let config = jobs_config.lock();
    let statuses = job_status.lock();
    statuses
        .iter()
        .filter_map(|(slug, status)| match status {
            JobStatus::Running {
                pane_id: Some(pid), ..
            } => config
                .jobs
                .iter()
                .find(|job| job.slug == *slug)
                .map(|job| (pid.clone(), (job.group.clone(), job.slug.clone()))),
            _ => None,
        })
        .collect()
}

fn collect_slug_to_group(jobs_config: &Arc<Mutex<JobsConfig>>) -> HashMap<String, String> {
    let config = jobs_config.lock();
    config
        .jobs
        .iter()
        .map(|job| (job.slug.clone(), job.group.clone()))
        .collect()
}

fn collect_match_entries(jobs_config: &Arc<Mutex<JobsConfig>>) -> Vec<(String, String, String)> {
    let config = jobs_config.lock();
    config
        .jobs
        .iter()
        .filter_map(|job| {
            if let Some(ref fp) = job.folder_path {
                Some((fp.clone(), job.group.clone(), job.slug.clone()))
            } else {
                job.work_dir
                    .as_ref()
                    .map(|wd| (wd.clone(), job.group.clone(), job.slug.clone()))
            }
        })
        .collect()
}

struct ProcessRow<'a> {
    pane_id: &'a str,
    command: &'a str,
    cwd: &'a str,
    session: &'a str,
    window: &'a str,
    pane_pid: &'a str,
    pane_title: Option<String>,
    pane_slug_tag: Option<String>,
}

#[derive(Default)]
struct SkipCounters {
    short: u32,
    view: u32,
    placeholder: u32,
}

fn parse_row(line: &str) -> Option<ProcessRow<'_>> {
    let parts: Vec<&str> = line.splitn(9, '\x1e').collect();
    if parts.len() < 8 {
        return None;
    }
    Some(ProcessRow {
        pane_id: parts[0],
        command: parts[1],
        cwd: parts[2],
        session: parts[3],
        window: parts[4],
        pane_pid: parts[5],
        pane_title: normalize_optional_text(parts[7].to_string()),
        pane_slug_tag: parts
            .get(8)
            .and_then(|s| normalize_optional_text((*s).to_string())),
    })
}

fn resolve_provider(row: &ProcessRow<'_>) -> Option<crate::agent_session::ProcessProvider> {
    let agent_provider =
        crate::agent_session::detect_process_provider(row.pane_pid, None).or_else(|| {
            is_semver(row.command).then_some(crate::agent_session::ProcessProvider::Claude)
        });
    let is_clawtab_shell_window =
        row.window.starts_with("ct-clawtab-shell-") || row.window.starts_with("clawtab-shell-");
    match (agent_provider, is_clawtab_shell_window) {
        (Some(p), _) => Some(p),
        (None, true) => Some(crate::agent_session::ProcessProvider::Shell),
        (None, false) => None,
    }
}

fn resolve_group_job(
    row: &ProcessRow<'_>,
    running_panes: &HashMap<String, (String, String)>,
    slug_to_group: &HashMap<String, String>,
    match_entries: &[(String, String, String)],
) -> (Option<String>, Option<String>) {
    if let Some((group, slug)) = running_panes.get(row.pane_id) {
        return (Some(group.clone()), Some(slug.clone()));
    }
    if let Some(group) = row
        .pane_slug_tag
        .as_ref()
        .and_then(|tag| slug_to_group.get(tag))
    {
        return (Some(group.clone()), row.pane_slug_tag.clone());
    }
    let best = match_entries
        .iter()
        .filter(|(root, _, _)| row.cwd == root || row.cwd.starts_with(&format!("{}/", root)))
        .max_by_key(|(root, _, _)| root.len());
    match best {
        Some((_, group, _)) => (Some(group.clone()), None),
        None => (None, None),
    }
}

fn build_remote(
    row: &ProcessRow<'_>,
    provider: crate::agent_session::ProcessProvider,
    matched_group: Option<String>,
    matched_job: Option<String>,
    live_viewer_panes: &HashSet<String>,
) -> DetectedProcess {
    let log_lines = if live_viewer_panes.contains(row.pane_id) {
        String::new()
    } else {
        crate::tmux::capture_pane(row.session, row.pane_id, 5)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let session_info = crate::agent_session::resolve_session_info_for_provider_with_cwd(
        row.pane_pid,
        Some(provider),
        None,
        Some(row.cwd),
    );
    let (can_fork_session, can_send_skills, can_inject_secrets) = match provider {
        crate::agent_session::ProcessProvider::Claude => (true, true, true),
        _ => (false, false, false),
    };
    let display_window = row
        .pane_title
        .clone()
        .unwrap_or_else(|| row.window.to_string());

    DetectedProcess {
        pane_id: row.pane_id.to_string(),
        cwd: row.cwd.to_string(),
        version: if is_semver(row.command) {
            row.command.to_string()
        } else {
            String::new()
        },
        provider: provider.as_str().to_string(),
        can_fork_session,
        can_send_skills,
        can_inject_secrets,
        tmux_session: row.session.to_string(),
        window_name: display_window,
        matched_group,
        matched_job,
        log_lines,
        first_query: session_info.first_query,
        last_query: session_info.last_query,
        session_started_at: session_info.session_started_at,
        token_count: session_info.token_count,
    }
}

fn is_semver(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn is_view_session(name: &str) -> bool {
    name.starts_with("clawtab-") && name.contains("-view-")
}

fn normalize_optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
