use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};

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

    let mut watcher = match RecommendedWatcher::new(
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

    if let Err(e) = watcher.watch(&jobs_dir, RecursiveMode::Recursive) {
        log::error!("Failed to watch jobs dir: {}", e);
        return;
    }

    log::info!("Watching jobs dir: {}", jobs_dir.display());

    let debounce = Duration::from_millis(500);
    let mut last_reload = Instant::now() - debounce;

    while let Some(ev) = rx.recv().await {
        let dominated_by_filter = !matches!(
            ev.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        );

        if dominated_by_filter {
            continue;
        }

        if last_reload.elapsed() < debounce {
            continue;
        }

        last_reload = Instant::now();

        let config = JobsConfig::load();
        *jobs_config.lock().unwrap() = config;
        let _ = app_handle.emit("jobs-changed", ());
        log::info!("Reloaded jobs config (fs change)");
    }

    // Keep watcher alive - dropping it stops watching.
    // This line is unreachable but prevents the compiler from
    // optimizing away the watcher.
    drop(watcher);
}
