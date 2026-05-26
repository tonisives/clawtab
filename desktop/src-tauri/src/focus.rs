//! App-level focus tracking for the auto-release-on-blur feature.
//!
//! When the `auto_release_on_blur` setting is enabled, all captured panes are
//! released back to their original tmux windows after the entire ClawTab app
//! has been blurred for `BLUR_DEBOUNCE`. When any ClawTab window regains
//! focus, a `panes-resume-requested` event is emitted so the frontend can
//! re-spawn its mounted panes (which re-captures them via the idempotent
//! `pty_spawn` path).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use crate::AppState;

const BLUR_DEBOUNCE: Duration = Duration::from_secs(3);

/// Generation counter incremented on every blur. A pending suspend task only
/// fires if its captured generation still matches when the debounce elapses.
static BLUR_GEN: AtomicU64 = AtomicU64::new(0);
/// Tracks whether the app is currently considered "active" (at least one
/// window focused). Used to avoid spamming resume on every inter-window
/// focus shuffle.
static APP_ACTIVE: Mutex<bool> = Mutex::new(true);

/// Wire a focus listener onto every existing webview window. Call once during
/// `setup_app`; covers `settings`, `debug`, `pty_debug`, `tmux_debug` since
/// the desktop app is tray-driven with no main window.
pub fn register(app: &tauri::App) {
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    for label in labels {
        let Some(window) = app.get_webview_window(&label) else {
            continue;
        };
        let handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let WindowEvent::Focused(focused) = event {
                on_focus_change(&handle, *focused);
            }
        });
    }
}

fn on_focus_change(app: &AppHandle, focused: bool) {
    if focused {
        // Cancel any pending suspend.
        BLUR_GEN.fetch_add(1, Ordering::Relaxed);
        let was_active = {
            let mut active = APP_ACTIVE.lock();
            let prev = *active;
            *active = true;
            prev
        };
        if !was_active {
            emit_resume(app);
        }
    } else {
        // A single window losing focus could just be inter-window movement,
        // or the user switching apps. Wait BLUR_DEBOUNCE; if no window has
        // refocused by then and the global focus check still shows no window
        // focused, treat it as app deactivation.
        let gen = BLUR_GEN.fetch_add(1, Ordering::Relaxed) + 1;
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(BLUR_DEBOUNCE);
            if BLUR_GEN.load(Ordering::Relaxed) != gen {
                return;
            }
            let any_focused = app
                .webview_windows()
                .values()
                .any(|w| w.is_focused().unwrap_or(false));
            if any_focused {
                return;
            }
            let was_active = {
                let mut active = APP_ACTIVE.lock();
                let prev = *active;
                *active = false;
                prev
            };
            if was_active {
                trigger_suspend(&app);
            }
        });
    }
}

fn trigger_suspend(app: &AppHandle) {
    suspend_if_enabled(app, "app blur");
}

pub fn suspend_if_enabled(app: &AppHandle, reason: &str) {
    let state = app.state::<AppState>();
    if !state.settings.lock().auto_release_on_blur {
        return;
    }
    let released = state.pty_manager.lock().suspend_all();
    if !released.is_empty() {
        log::info!(
            "auto-release: suspended {} pane(s) on {}",
            released.len(),
            reason
        );
    }
    let _ = app.emit("panes-suspended", &released);
}

fn emit_resume(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.settings.lock().auto_release_on_blur {
        return;
    }
    let _ = app.emit("panes-resume-requested", ());
}
