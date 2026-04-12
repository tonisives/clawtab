use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

use crate::config::jobs::JobsConfig;

pub async fn watch_jobs_dir(jobs_config: Arc<Mutex<JobsConfig>>, app_handle: tauri::AppHandle) {
    let jobs_dir = match JobsConfig::jobs_dir_public() {
        Some(d) => d,
        None => {
            log::warn!("Cannot determine jobs dir for watcher");
            return;
        }
    };

    let (tx, mut rx) = mpsc::channel::<Event>(64);

    let watcher = match RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(ev) = res {
                let _ = tx.blocking_send(ev);
            }
        },
        notify::Config::default(),
    ) {
        Ok(w) => w,
        Err(e) => {
            log::error!("Failed to create fs watcher: {}", e);
            return;
        }
    };

    // Hold the watcher for the lifetime of this task.
    let mut watcher = watcher;
    if let Err(e) = watcher.watch(&jobs_dir, RecursiveMode::Recursive) {
        log::error!("Failed to watch jobs dir: {}", e);
        return;
    }

    log::info!("Watching jobs dir: {}", jobs_dir.display());

    let debounce = Duration::from_millis(300);

    loop {
        // Block until first relevant event.
        let first = match rx.recv().await {
            Some(ev) => ev,
            None => break,
        };
        if !is_relevant(&first) {
            continue;
        }

        // Trailing-edge debounce: drain further events until the channel is
        // idle for `debounce`, then reload once.
        loop {
            tokio::select! {
                biased;
                maybe_ev = rx.recv() => {
                    match maybe_ev {
                        Some(ev) if is_relevant(&ev) => continue,
                        Some(_) => continue,
                        None => return,
                    }
                }
                _ = sleep(debounce) => { break; }
            }
        }

        let config = JobsConfig::load();
        *jobs_config.lock().unwrap() = config;
        let _ = app_handle.emit("jobs-changed", ());
        log::info!("Reloaded jobs config (fs change)");
    }

    drop(watcher);
}

fn is_relevant(ev: &Event) -> bool {
    let kind_ok = matches!(
        ev.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    );
    if !kind_ok {
        return false;
    }

    // Ignore churn from logs/ and other noise; only react to the files that
    // actually define a job.
    ev.paths.iter().any(|p| is_job_file(p))
}

fn is_job_file(path: &Path) -> bool {
    // Skip anything under a logs/ directory.
    if path
        .components()
        .any(|c| c.as_os_str() == std::ffi::OsStr::new("logs"))
    {
        return false;
    }
    match path.file_name().and_then(|n| n.to_str()) {
        Some("job.yaml") | Some("job.md") | Some("context.md") => true,
        _ => false,
    }
}
