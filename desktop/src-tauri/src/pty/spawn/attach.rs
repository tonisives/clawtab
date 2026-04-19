use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

pub(super) struct AttachedPty {
    pub reader: Box<dyn Read + Send>,
    pub writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
}

/// Open a local PTY and spawn `tmux attach-session -t <view_session>` inside
/// it. Returns the reader/writer/master handles the caller needs to wire up
/// the reader thread and the `PaneViewer`.
pub(super) fn open_pty_and_attach(
    pane_id: &str,
    view_session: &str,
    cols: u16,
    rows: u16,
    spawn_started: Instant,
) -> Result<AttachedPty, String> {
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
    cmd.args(["attach-session", "-t", view_session]);
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

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {}", e))?;

    Ok(AttachedPty {
        reader,
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
    })
}
