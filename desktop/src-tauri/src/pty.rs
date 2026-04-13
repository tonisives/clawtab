use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

use crate::debug_spawn;

/// Pane viewer: captured pane moved into a new `ct-<orig>-<N>` window in its
/// original tmux session, streamed via a local PTY running `tmux attach-session`
/// against an ephemeral grouped view session. This gives us independent resize
/// on the captured window without disturbing other clients of the real tmux
/// server, while keeping the pane discoverable inside its original session.
struct PaneViewer {
    stop: Arc<AtomicBool>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// Captured window id (@...) in the original session.
    window_id: String,
    /// Ephemeral grouped view session (clawtab-view-N); killed on stop.
    view_session: String,
    /// Monotonic attachment generation for this pane viewer.
    attach_generation: u64,
}

const MAX_RECENT_PANES: usize = 12;
const MAX_CACHED_BYTES_PER_PANE: usize = 256 * 1024;
const PTY_EMIT_BATCH_MS: u64 = 16;
const PTY_EMIT_MAX_BYTES: usize = 32 * 1024;
struct RecentPaneCache {
    order: VecDeque<String>,
    entries: HashMap<String, Vec<u8>>,
}

impl RecentPaneCache {
    fn new() -> Self {
        Self {
            order: VecDeque::new(),
            entries: HashMap::new(),
        }
    }

    fn touch(&mut self, pane_id: &str) {
        if let Some(idx) = self.order.iter().position(|id| id == pane_id) {
            self.order.remove(idx);
        }
        self.order.push_front(pane_id.to_string());
        while self.order.len() > MAX_RECENT_PANES {
            if let Some(oldest) = self.order.pop_back() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn append(&mut self, pane_id: &str, bytes: &[u8]) {
        if bytes.is_empty() {
            self.touch(pane_id);
            return;
        }

        self.touch(pane_id);
        let entry = self.entries.entry(pane_id.to_string()).or_default();
        entry.extend_from_slice(bytes);
        if entry.len() > MAX_CACHED_BYTES_PER_PANE {
            let overflow = entry.len() - MAX_CACHED_BYTES_PER_PANE;
            entry.drain(..overflow);
        }
    }

    fn get(&mut self, pane_id: &str) -> Vec<u8> {
        if self.entries.contains_key(pane_id) {
            self.touch(pane_id);
        }
        self.entries.get(pane_id).cloned().unwrap_or_default()
    }
}

/// Where PTY output bytes should be sent.
pub enum OutputSink {
    /// Emit as Tauri event (local desktop xterm.js)
    Tauri(AppHandle),
    /// Send via channel (relay forwarding to remote clients)
    Channel(std::sync::mpsc::Sender<(String, Vec<u8>)>),
}

/// Returned from spawn so the frontend knows the pane's native size at capture time.
pub struct SpawnResult {
    pub native_cols: u16,
    pub native_rows: u16,
    pub attach_generation: u64,
}

pub struct PtyManager {
    sessions: HashMap<String, PaneViewer>,
    recent: Arc<Mutex<RecentPaneCache>>,
}

static VIEW_COUNTER: AtomicU64 = AtomicU64::new(0);
static ATTACH_COUNTER: AtomicU64 = AtomicU64::new(1);

fn tmux(args: &[&str]) -> Result<String, String> {
    tmux_at(args, "pty::tmux")
}

fn tmux_at(args: &[&str], callsite: &'static str) -> Result<String, String> {
    let out = debug_spawn::run_logged("tmux", args, callsite)
        .map_err(|e| format!("tmux {}: {}", args[0], e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("tmux {}: {}", args[0], stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn emit_bytes(sink: &OutputSink, pane_id: &str, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }

    match sink {
        OutputSink::Tauri(app_handle) => {
            let _ = app_handle.emit(&format!("pty-output-{}", pane_id.replace('%', "p")), bytes);
        }
        OutputSink::Channel(tx) => {
            let _ = tx.send((pane_id.to_string(), bytes));
        }
    }
}

fn emit_initial_snapshot(sink: &OutputSink, recent: &Arc<Mutex<RecentPaneCache>>, pane_id: &str) {
    let started = Instant::now();
    // Clear the terminal before sending a fresh full-screen snapshot.
    let clear = b"\x1bc".to_vec();
    recent.lock().unwrap().append(pane_id, &clear);
    emit_bytes(sink, pane_id, clear);
    log::debug!(
        "[pty {}] initial snapshot clear emitted after {}ms",
        pane_id,
        started.elapsed().as_millis()
    );

    match tmux(&["capture-pane", "-e", "-p", "-t", pane_id]) {
        Ok(content) => {
            let bytes = content.into_bytes();
            let byte_len = bytes.len();
            if !bytes.is_empty() {
                recent.lock().unwrap().append(pane_id, &bytes);
                emit_bytes(sink, pane_id, bytes);
            }
            log::debug!(
                "[pty {}] initial snapshot capture emitted {} bytes after {}ms",
                pane_id,
                byte_len,
                started.elapsed().as_millis()
            );
        }
        Err(err) => log::debug!(
            "[pty {}] initial snapshot capture failed after {}ms: {}",
            pane_id,
            started.elapsed().as_millis(),
            err
        ),
    }
}

fn refresh_attached_pane(sink: &OutputSink, recent: &Arc<Mutex<RecentPaneCache>>, pane_id: &str) {
    thread::sleep(Duration::from_millis(150));
    emit_initial_snapshot(sink, recent, pane_id);
}

fn tmux_session_exists(session: &str) -> bool {
    debug_spawn::run_logged(
        "tmux",
        &["has-session", "-t", session],
        "pty::tmux_session_exists",
    )
    .map(|out| out.status.success())
    .unwrap_or(false)
}

fn next_view_session_name() -> String {
    loop {
        let view_id = VIEW_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = format!("clawtab-view-{}", view_id);
        if !tmux_session_exists(&candidate) {
            return candidate;
        }
    }
}

fn is_view_session(name: &str) -> bool {
    name.starts_with("clawtab-") && name.contains("-view-")
}

fn resolve_non_view_session_for_window(window_id: &str, fallback: &str) -> String {
    let raw = match tmux(&["list-windows", "-a", "-F", "#{session_name}\t#{window_id}"]) {
        Ok(v) => v,
        Err(_) => return fallback.to_string(),
    };

    for line in raw.lines() {
        let mut parts = line.splitn(2, '\t');
        let session = parts.next().unwrap_or("");
        let current_window_id = parts.next().unwrap_or("");
        if current_window_id == window_id && !is_view_session(session) {
            return session.to_string();
        }
    }

    fallback.to_string()
}

/// Sweep orphaned ephemeral view sessions left behind by a previous run.
///
/// View sessions are created via `tmux new-session -t base`, which puts them
/// in a session group sharing windows with the base. `kill-session` only kills
/// the named session — the base and its windows survive as long as another
/// group member exists. To guard the edge case where a real session ends up
/// with its group name set to a view (e.g. base was created *from* the view),
/// we skip any view session that is the *only* remaining member of its group.
fn cleanup_orphaned_view_sessions(keep: &[&str]) {
    let raw = match tmux(&["list-sessions", "-F", "#{session_name}\t#{session_group}"]) {
        Ok(v) => v,
        Err(e) => {
            log::debug!(
                "cleanup_orphaned_view_sessions: list-sessions failed: {}",
                e
            );
            return;
        }
    };

    // group -> list of member session names. Sessions with no group list
    // themselves under their own name so the "last member" check still works.
    let mut members: HashMap<String, Vec<String>> = HashMap::new();
    let mut view_sessions: Vec<(String, String)> = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(2, '\t');
        let name = parts.next().unwrap_or("").to_string();
        let group = parts.next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let group_key = if group.is_empty() {
            name.clone()
        } else {
            group
        };
        members
            .entry(group_key.clone())
            .or_default()
            .push(name.clone());
        if is_view_session(&name) {
            view_sessions.push((name, group_key));
        }
    }

    let keep: std::collections::HashSet<&str> = keep.iter().copied().collect();
    let mut killed = 0usize;
    let mut skipped_last = 0usize;
    for (name, group_key) in view_sessions {
        if keep.contains(name.as_str()) {
            continue;
        }
        let group_members = members.get(&group_key);
        let has_non_view_member = group_members
            .map(|m| m.iter().any(|n| !is_view_session(n)))
            .unwrap_or(false);
        if !has_non_view_member {
            log::warn!(
                "cleanup_orphaned_view_sessions: skipping {} — last member of group {}",
                name,
                group_key
            );
            skipped_last += 1;
            continue;
        }
        match tmux(&["kill-session", "-t", &name]) {
            Ok(_) => killed += 1,
            Err(e) => log::debug!(
                "cleanup_orphaned_view_sessions: kill {} failed: {}",
                name,
                e
            ),
        }
    }

    if killed > 0 || skipped_last > 0 {
        log::info!(
            "cleanup_orphaned_view_sessions: killed {}, skipped {} (last member of group)",
            killed,
            skipped_last
        );
    }
}

fn is_idle_shell_command(cmd: &str) -> bool {
    matches!(
        cmd,
        "zsh" | "bash" | "sh" | "fish" | "dash" | "ksh" | "tcsh"
    )
}

/// Sweep `ct-*` windows whose only process is an idle shell. Leaves windows
/// running real processes (codex, opencode, agents, editors, ...) alone so
/// they can be released manually via the app UI.
///
/// These orphans accumulate when the app crashes or force-quits while a pane
/// viewer is open: the view session dies (or gets swept), but the captured
/// `ct-*` window parks in its base session with no tab pointing at it.
fn cleanup_orphaned_ct_windows() {
    let raw = match tmux(&[
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{window_id}\t#{window_name}\t#{pane_current_command}",
    ]) {
        Ok(v) => v,
        Err(e) => {
            log::debug!("cleanup_orphaned_ct_windows: list-panes failed: {}", e);
            return;
        }
    };

    let mut killed = 0usize;
    let mut kept = 0usize;
    let mut seen_windows: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in raw.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 4 {
            continue;
        }
        let session = parts[0];
        let window_id = parts[1];
        let window_name = parts[2];
        let cmd = parts[3];

        if !window_name.starts_with("ct-") {
            continue;
        }
        // Skip group-member duplicates: list-panes -a reports the same window
        // under every session group member, and we want to act on it under
        // its real (non-view) session.
        if is_view_session(session) {
            continue;
        }
        if !seen_windows.insert(window_id.to_string()) {
            continue;
        }

        if is_idle_shell_command(cmd) {
            match tmux(&["kill-window", "-t", window_id]) {
                Ok(_) => {
                    log::info!(
                        "cleanup_orphaned_ct_windows: killed {} ({}:{}) idle {}",
                        window_name,
                        session,
                        window_id,
                        cmd
                    );
                    killed += 1;
                }
                Err(e) => log::debug!(
                    "cleanup_orphaned_ct_windows: kill {} failed: {}",
                    window_id,
                    e
                ),
            }
        } else {
            log::info!(
                "cleanup_orphaned_ct_windows: keeping {} ({}:{}) running {}",
                window_name,
                session,
                window_id,
                cmd
            );
            kept += 1;
        }
    }

    if killed > 0 || kept > 0 {
        log::info!(
            "cleanup_orphaned_ct_windows: killed {} idle, kept {} live",
            killed,
            kept
        );
    }
}

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

/// Returns Some((session, window_id)) if the pane is already in a ct-* window
/// (i.e. already captured by clawtab).
fn find_captured_window(pane_id: &str) -> Option<(String, String)> {
    let info = tmux(&[
        "display-message",
        "-t",
        pane_id,
        "-p",
        "#{session_name}\t#{window_id}\t#{window_name}",
    ])
    .ok()?;
    let parts: Vec<&str> = info.split('\t').collect();
    if parts.len() == 3 && parts[2].starts_with("ct-") {
        let session = resolve_non_view_session_for_window(parts[1], parts[0]);
        Some((session, parts[1].to_string()))
    } else {
        None
    }
}

/// Return the next available `ct-<base>-<N>` window name in `session`.
/// Starts at 1 and picks the smallest unused integer suffix.
fn next_ct_window_name(session: &str, base: &str) -> String {
    let base = if base.is_empty() { "pane" } else { base };
    let existing =
        tmux(&["list-windows", "-t", session, "-F", "#{window_name}"]).unwrap_or_default();
    let prefix = format!("ct-{}-", base);
    let mut used = std::collections::HashSet::new();
    for line in existing.lines() {
        if let Some(rest) = line.strip_prefix(&prefix) {
            if let Ok(n) = rest.parse::<u32>() {
                used.insert(n);
            }
        }
    }
    let mut n = 1u32;
    while used.contains(&n) {
        n += 1;
    }
    format!("ct-{}-{}", base, n)
}

/// Break a pane into a new `ct-<orig_window_name>-<N>` window inside the pane's
/// original tmux session. Records origin as a window option so release can put
/// it back. Returns (session, window_id). Idempotent: if already captured,
/// returns the existing session/window.
///
/// `tmux_session` MUST be the real owning session of the pane, supplied by the
/// caller. Do NOT trust `#{session_name}` from `display-message -t %pane_id`:
/// when a pane's window is shared across a session group, tmux resolves the
/// pane target to whichever group member it feels like (often the most recent
/// ephemeral `clawtab-view-N`), recording a dead view session as the origin.
///
/// IMPORTANT: targets use the raw `%pane_id` form, NOT `session:%pane_id`.
/// In tmux, `session:target` interprets `target` as a window reference — when
/// target starts with `%`, tmux treats it as the active pane of the session,
/// NOT the pane with that ID. Pane IDs are globally unique, so the session
/// prefix adds nothing here and actively breaks pane lookup.
fn capture_pane(pane_id: &str, tmux_session: &str) -> Result<(String, String), String> {
    if let Some((existing_sess, existing_win)) = find_captured_window(pane_id) {
        // If the existing ct-* window holds only this pane, we're done.
        // Otherwise the pane is sharing a window with siblings (either because
        // the user split it from an outside terminal, or from a pre-fix fork),
        // and the viewer would render whichever pane tmux considers active. We
        // break it out into its own fresh ct-* window so every clawtab-managed
        // pane lives alone.
        let pane_count_raw = tmux(&[
            "display-message",
            "-t",
            &existing_win,
            "-p",
            "#{window_panes}",
        ])?;
        let pane_count: u32 = pane_count_raw.trim().parse().unwrap_or(1);
        if pane_count <= 1 {
            return Ok((existing_sess, existing_win));
        }

        // Origin session from @clawtab-origin is authoritative. See the big
        // comment below about why #{session_name} is unreliable here.
        let origin_meta_raw = tmux(&[
            "show-options",
            "-w",
            "-v",
            "-t",
            &existing_win,
            "@clawtab-origin",
        ])
        .unwrap_or_default();
        let origin_parts: Vec<&str> = origin_meta_raw.split('\t').collect();
        let origin_session = origin_parts.first().copied().unwrap_or(tmux_session);
        let origin_window_id = origin_parts.get(1).copied().unwrap_or("");
        let origin_pane_index = origin_parts.get(2).copied().unwrap_or("0");
        let origin_window_name = origin_parts.get(3).copied().unwrap_or("pane");

        let new_name = next_ct_window_name(origin_session, origin_window_name);
        tmux(&[
            "break-pane",
            "-d",
            "-s",
            pane_id,
            "-t",
            &format!("{}:", origin_session),
            "-n",
            &new_name,
        ])?;

        let new_win = tmux(&["display-message", "-t", pane_id, "-p", "#{window_id}"])?;

        let origin_meta = format!(
            "{}\t{}\t{}\t{}",
            origin_session, origin_window_id, origin_pane_index, origin_window_name
        );
        let _ = tmux(&[
            "set-option",
            "-w",
            "-t",
            &new_win,
            "@clawtab-origin",
            &origin_meta,
        ]);

        return Ok((origin_session.to_string(), new_win));
    }

    let origin = tmux(&[
        "display-message",
        "-t",
        pane_id,
        "-p",
        "#{window_id}\t#{pane_index}\t#{window_name}",
    ])?;

    let parts: Vec<&str> = origin.split('\t').collect();
    if parts.len() < 3 {
        return Err(format!("malformed origin: {}", origin));
    }
    let orig_window_id = parts[0];
    let orig_pane_index = parts[1];
    let orig_window_name = parts[2];

    let new_name = next_ct_window_name(tmux_session, orig_window_name);

    tmux(&[
        "break-pane",
        "-d",
        "-s",
        pane_id,
        "-t",
        &format!("{}:", tmux_session),
        "-n",
        &new_name,
    ])?;

    let new_win = tmux(&["display-message", "-t", pane_id, "-p", "#{window_id}"])?;

    // Origin metadata: session\twindow_id\tpane_index\twindow_name (matches the
    // format release_captured_pane expects).
    let origin_meta = format!(
        "{}\t{}\t{}\t{}",
        tmux_session, orig_window_id, orig_pane_index, orig_window_name
    );
    let _ = tmux(&[
        "set-option",
        "-w",
        "-t",
        &new_win,
        "@clawtab-origin",
        &origin_meta,
    ]);

    Ok((tmux_session.to_string(), new_win))
}

/// Release a captured pane back to its original session:window.
///
/// If the original window still exists in the original session, the pane is
/// joined back into it. If the original window is gone (because the pane was
/// the last one in it when captured, and break-pane migrated the window_id),
/// a new window with the original name is created in the original session.
/// If the original session is also gone, a new session with the original name
/// is created.
fn release_captured_pane(pane_id: &str) -> Result<(), String> {
    let (_, _cap_win) = find_captured_window(pane_id).ok_or("pane is not captured")?;

    // Read origin from the current (captured) window of the pane.
    let cap_win_now = tmux(&["display-message", "-t", pane_id, "-p", "#{window_id}"])?;
    let origin = tmux(&[
        "show-options",
        "-w",
        "-v",
        "-t",
        &cap_win_now,
        "@clawtab-origin",
    ])
    .map_err(|e| format!("no origin recorded: {}", e))?;

    let parts: Vec<&str> = origin.split('\t').collect();
    if parts.len() < 2 {
        return Err(format!("malformed origin: {}", origin));
    }
    let orig_session = parts[0];
    let orig_window = parts[1];
    let orig_window_name = parts.get(3).copied().unwrap_or("");

    // Does the original session still exist?
    let session_exists = debug_spawn::run_logged(
        "tmux",
        &["has-session", "-t", orig_session],
        "pty::release_captured_pane::has-session",
    )
    .map(|o| o.status.success())
    .unwrap_or(false);
    if !session_exists {
        tmux(&[
            "new-session",
            "-d",
            "-s",
            orig_session,
            "-n",
            "__tmp",
            "sh",
            "-c",
            "while :; do sleep 3600; done",
        ])?;
        let name = if orig_window_name.is_empty() {
            "restored"
        } else {
            orig_window_name
        };
        tmux(&[
            "break-pane",
            "-d",
            "-s",
            pane_id,
            "-t",
            &format!("{}:", orig_session),
            "-n",
            name,
        ])?;
        let _ = tmux(&["kill-window", "-t", &format!("{}:__tmp", orig_session)]);
        return Ok(());
    }

    // Does the original window still belong to the original session?
    // Note: @window_id is globally unique in tmux, but `display-message -t session:@id`
    // resolves the window_id globally and ignores the session prefix. So we have to
    // check session membership explicitly by listing the windows of orig_session.
    let windows_in_session =
        tmux(&["list-windows", "-t", orig_session, "-F", "#{window_id}"]).unwrap_or_default();
    let window_exists = windows_in_session.lines().any(|l| l.trim() == orig_window);

    if window_exists {
        tmux(&["join-pane", "-s", pane_id, "-t", orig_window])?;
        if !orig_window_name.is_empty() {
            let _ = tmux(&["rename-window", "-t", orig_window, orig_window_name]);
        }
    } else {
        let name = if orig_window_name.is_empty() {
            "restored"
        } else {
            orig_window_name
        };
        tmux(&[
            "break-pane",
            "-d",
            "-s",
            pane_id,
            "-t",
            &format!("{}:", orig_session),
            "-n",
            name,
        ])?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// PtyManager
// ---------------------------------------------------------------------------

impl PtyManager {
    pub fn new() -> Self {
        // On startup, self.sessions is empty — any existing clawtab-*-view-*
        // session is an orphan from a previous run. View sweep first so the
        // ct-* sweep doesn't see panes under view sessions.
        cleanup_orphaned_view_sessions(&[]);
        cleanup_orphaned_ct_windows();
        Self {
            sessions: HashMap::new(),
            recent: Arc::new(Mutex::new(RecentPaneCache::new())),
        }
    }

    pub fn active_pane_ids(&self) -> std::collections::HashSet<String> {
        self.sessions.keys().cloned().collect()
    }

    pub fn spawn(
        &mut self,
        pane_id: &str,
        tmux_session: &str,
        cols: u16,
        rows: u16,
        _group: &str,
        sink: OutputSink,
    ) -> Result<SpawnResult, String> {
        let spawn_started = Instant::now();
        log::debug!(
            "[pty {}] spawn start session={} size={}x{}",
            pane_id,
            tmux_session,
            cols,
            rows
        );

        if let Some(viewer) = self.sessions.get_mut(pane_id) {
            let attach_generation = ATTACH_COUNTER.fetch_add(1, Ordering::Relaxed);
            viewer.attach_generation = attach_generation;
            self.resize(pane_id, cols, rows)?;
            log::debug!(
                "[pty {}] reused existing viewer generation={} resized after {}ms",
                pane_id,
                attach_generation,
                spawn_started.elapsed().as_millis()
            );
            refresh_attached_pane(&sink, &self.recent, pane_id);

            let native_info = tmux(&[
                "display-message",
                "-t",
                pane_id,
                "-p",
                "#{pane_width} #{pane_height}",
            ])?;
            let native_parts: Vec<&str> = native_info.split(' ').collect();
            let native_cols: u16 = native_parts
                .first()
                .and_then(|s| s.parse().ok())
                .unwrap_or(80);
            let native_rows: u16 = native_parts
                .get(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(24);

            let result = SpawnResult {
                native_cols,
                native_rows,
                attach_generation,
            };
            log::debug!(
                "[pty {}] reused existing viewer spawn complete after {}ms native={}x{}",
                pane_id,
                spawn_started.elapsed().as_millis(),
                result.native_cols,
                result.native_rows
            );
            return Ok(result);
        }

        // Read the pane's native size before capture. After capture + resize we
        // mutate it, so this captures the "original" view the user expected.
        let native_info = tmux(&[
            "display-message",
            "-t",
            pane_id,
            "-p",
            "#{pane_width} #{pane_height}",
        ])?;
        let native_parts: Vec<&str> = native_info.split(' ').collect();
        let native_cols: u16 = native_parts
            .first()
            .and_then(|s| s.parse().ok())
            .unwrap_or(80);
        let native_rows: u16 = native_parts
            .get(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(24);
        log::debug!(
            "[pty {}] native size {}x{} read after {}ms",
            pane_id,
            native_cols,
            native_rows,
            spawn_started.elapsed().as_millis()
        );

        // Capture the pane into a ct-<orig>-<N> window in its original session
        // (idempotent). base_session here is the original tmux session.
        let (base_session, window_id) = capture_pane(pane_id, tmux_session)?;
        log::debug!(
            "[pty {}] captured base_session={} window_id={} after {}ms",
            pane_id,
            base_session,
            window_id,
            spawn_started.elapsed().as_millis()
        );

        // Ephemeral grouped view session so this viewer has its own current-window
        // without disturbing other clients attached to the original session.
        let view_session = next_view_session_name();
        tmux(&[
            "new-session",
            "-d",
            "-s",
            &view_session,
            "-t",
            &base_session,
        ])?;
        let _ = tmux(&["set-option", "-t", &view_session, "status", "off"]);
        tmux(&[
            "select-window",
            "-t",
            &format!("{}:{}", view_session, window_id),
        ])?;
        log::debug!(
            "[pty {}] view session {} ready after {}ms",
            pane_id,
            view_session,
            spawn_started.elapsed().as_millis()
        );

        // Open a local PTY and spawn `tmux attach-session` inside it.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {}", e))?;

        let mut cmd = CommandBuilder::new("tmux");
        cmd.args(["attach-session", "-t", &view_session]);
        cmd.env("TERM", "xterm-256color");

        let _child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("tmux attach spawn: {}", e))?;
        drop(pair.slave);
        log::debug!(
            "[pty {}] attach-session spawned after {}ms",
            pane_id,
            spawn_started.elapsed().as_millis()
        );

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer: {}", e))?;
        let writer = Arc::new(Mutex::new(writer));
        let master = Arc::new(Mutex::new(pair.master));

        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop);
        let attach_generation = ATTACH_COUNTER.fetch_add(1, Ordering::Relaxed);
        let event_key = pane_id.replace('%', "p");
        let pane_id_for_thread = pane_id.to_string();
        let recent_cache = Arc::clone(&self.recent);

        // Resize the captured window to match the viewport so content reflows.
        if cols > 0 && rows > 0 {
            let _ = tmux(&[
                "resize-window",
                "-t",
                &window_id,
                "-x",
                &cols.to_string(),
                "-y",
                &rows.to_string(),
            ]);
        }

        // Let attach-session settle, then push a full snapshot and force redraw.
        refresh_attached_pane(&sink, &self.recent, pane_id);
        log::debug!(
            "[pty {}] initial refresh done after {}ms",
            pane_id,
            spawn_started.elapsed().as_millis()
        );

        thread::spawn(move || {
            let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>();
            let reader_stop = Arc::clone(&stop_clone);

            thread::spawn(move || {
                let mut buf = [0u8; 8192];

                loop {
                    if reader_stop.load(Ordering::Relaxed) {
                        break;
                    }
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if output_tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });

            let mut pending = Vec::new();
            let batch_window = Duration::from_millis(PTY_EMIT_BATCH_MS);
            let idle_poll = Duration::from_millis(250);
            let mut flush_deadline: Option<Instant> = None;

            let flush_pending = |pending: &mut Vec<u8>| {
                if pending.is_empty() {
                    return;
                }
                let bytes = std::mem::take(pending);
                recent_cache
                    .lock()
                    .unwrap()
                    .append(&pane_id_for_thread, &bytes);
                match &sink {
                    OutputSink::Tauri(app_handle) => {
                        let _ = app_handle.emit(&format!("pty-output-{}", event_key), bytes);
                    }
                    OutputSink::Channel(tx) => {
                        let _ = tx.send((pane_id_for_thread.clone(), bytes));
                    }
                }
            };

            loop {
                if stop_clone.load(Ordering::Relaxed) {
                    break;
                }
                let timeout = flush_deadline
                    .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                    .unwrap_or(idle_poll);
                match output_rx.recv_timeout(timeout) {
                    Ok(bytes) => {
                        if pending.is_empty() {
                            flush_deadline = Some(Instant::now() + batch_window);
                        }
                        pending.extend_from_slice(&bytes);
                        if pending.len() >= PTY_EMIT_MAX_BYTES {
                            flush_pending(&mut pending);
                            flush_deadline = None;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        flush_pending(&mut pending);
                        flush_deadline = None;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if !pending.is_empty() {
                            flush_pending(&mut pending);
                        }
                        break;
                    }
                }
            }
            flush_pending(&mut pending);
            log::debug!("[pty {}] reader thread exited", event_key);
        });

        self.sessions.insert(
            pane_id.to_string(),
            PaneViewer {
                stop,
                writer,
                master,
                window_id,
                view_session,
                attach_generation,
            },
        );

        let result = SpawnResult {
            native_cols,
            native_rows,
            attach_generation,
        };
        log::debug!(
            "[pty {}] spawn complete generation={} after {}ms",
            pane_id,
            attach_generation,
            spawn_started.elapsed().as_millis()
        );
        Ok(result)
    }

    pub fn get_cached_output(&self, pane_id: &str) -> Vec<u8> {
        self.recent.lock().unwrap().get(pane_id)
    }

    pub fn write(&mut self, pane_id: &str, data: &[u8]) -> Result<(), String> {
        let viewer = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;
        viewer
            .writer
            .lock()
            .unwrap()
            .write_all(data)
            .map_err(|e| format!("pty write: {}", e))?;
        Ok(())
    }

    pub fn resize(&mut self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }

        let viewer = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;

        viewer
            .master
            .lock()
            .unwrap()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty resize: {}", e))?;

        let _ = tmux(&[
            "resize-window",
            "-t",
            &viewer.window_id,
            "-x",
            &cols.to_string(),
            "-y",
            &rows.to_string(),
        ]);

        Ok(())
    }

    pub fn destroy(
        &mut self,
        pane_id: &str,
        expected_generation: Option<u64>,
    ) -> Result<(), String> {
        if let Some(expected) = expected_generation {
            if let Some(viewer) = self.sessions.get(pane_id) {
                if viewer.attach_generation != expected {
                    return Ok(());
                }
            } else {
                return Ok(());
            }
        }

        if let Some(viewer) = self.sessions.remove(pane_id) {
            viewer.stop.store(true, Ordering::Relaxed);
            // Kill only the ephemeral view session. The captured window stays
            // in clawtab-<group> so the user can re-attach or release later.
            let _ = tmux(&["kill-session", "-t", &viewer.view_session]);
        }
        Ok(())
    }

    pub fn release(&mut self, pane_id: &str) -> Result<(), String> {
        let _ = self.destroy(pane_id, None);
        // Give tmux a moment for the PTY to detach before moving the pane.
        thread::sleep(Duration::from_millis(100));
        release_captured_pane(pane_id)
    }

    pub fn destroy_all(&mut self) {
        let pane_ids: Vec<String> = self.sessions.keys().cloned().collect();
        for pane_id in pane_ids {
            let _ = self.destroy(&pane_id, None);
        }
    }
}

pub type SharedPtyManager = Arc<Mutex<PtyManager>>;
