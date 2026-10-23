//! Shared terminal operations. Tmux layout operations remain tmux-specific.
use crate::managed::{self, Request, Response, Status};
pub use crate::tmux::*;
use std::collections::BTreeMap;

pub fn info(id: &str) -> Result<managed::SessionInfo, String> {
    match managed::request(id, Request::Info)? {
        Response::Info { session } => Ok(session),
        _ => Err("invalid managed session response".into()),
    }
}

pub fn snapshot(id: &str) -> Result<managed::Snapshot, String> {
    match managed::request(id, Request::Snapshot { after: None })? {
        Response::Snapshot { snapshot } => Ok(snapshot),
        _ => Err("invalid managed screen response".into()),
    }
}

fn capture(id: &str, history: bool, ansi: bool, lines: u32) -> Result<String, String> {
    match managed::request(
        id,
        Request::Capture {
            history,
            ansi,
            lines,
        },
    )? {
        Response::Capture { content } => Ok(content),
        _ => Err("invalid managed capture response".into()),
    }
}

fn input(id: &str, data: Vec<u8>) -> Result<(), String> {
    managed::request(id, Request::AutomationInput { data }).map(|_| ())
}

pub fn metadata(id: &str, key: &str, value: &str) -> Result<(), String> {
    managed::request(
        id,
        Request::Metadata {
            values: BTreeMap::from([(key.into(), value.into())]),
            conversation_id: None,
        },
    )
    .map(|_| ())
}

pub fn capture_pane_visible(id: &str) -> Result<(String, u16), String> {
    if !managed::is_managed(id) {
        return crate::tmux::capture_pane_visible(id);
    }
    let snapshot = snapshot(id)?;
    Ok((
        capture(id, false, true, snapshot.size.rows.into())?,
        snapshot.size.rows,
    ))
}
pub fn capture_pane_visible_text(id: &str) -> Result<String, String> {
    if managed::is_managed(id) {
        capture(id, false, false, 300)
    } else {
        crate::tmux::capture_pane_visible_text(id)
    }
}
pub fn capture_pane(session: &str, id: &str, lines: u32) -> Result<String, String> {
    if managed::is_managed(id) {
        capture(id, true, false, lines)
    } else {
        crate::tmux::capture_pane(session, id, lines)
    }
}
pub fn capture_pane_history(id: &str, lines: u32) -> Result<String, String> {
    if managed::is_managed(id) {
        capture(id, true, false, lines)
    } else {
        crate::tmux::capture_pane_history(id, lines)
    }
}
pub fn capture_pane_screen(id: &str, rows: u16) -> Result<String, String> {
    if managed::is_managed(id) {
        capture(id, false, true, rows.into())
    } else {
        crate::tmux::capture_pane_screen(id, rows)
    }
}
pub fn capture_pane_screens(panes: &[(&str, u16)]) -> Result<Vec<String>, String> {
    if panes.iter().all(|(id, _)| !managed::is_managed(id)) {
        return crate::tmux::capture_pane_screens(panes);
    }
    panes
        .iter()
        .map(|(id, rows)| capture_pane_screen(id, *rows))
        .collect()
}
pub fn capture_pane_full(id: &str) -> Result<String, String> {
    if managed::is_managed(id) {
        capture(id, true, false, 10300)
    } else {
        crate::tmux::capture_pane_full(id)
    }
}
pub fn capture_pane_escaped(id: &str) -> Result<String, String> {
    if managed::is_managed(id) {
        capture(id, false, true, 300)
    } else {
        crate::tmux::capture_pane_escaped(id)
    }
}
pub fn send_literal_to_pane(id: &str, text: &str) -> Result<(), String> {
    if managed::is_managed(id) {
        input(id, text.as_bytes().to_vec())
    } else {
        crate::tmux::send_literal_to_pane(id, text)
    }
}
pub fn send_keys_to_pane(session: &str, id: &str, text: &str) -> Result<(), String> {
    if managed::is_managed(id) {
        input(id, format!("{text}\r").into_bytes())
    } else {
        crate::tmux::send_keys_to_pane(session, id, text)
    }
}
pub fn send_keys_to_tui_pane(id: &str, text: &str) -> Result<(), String> {
    if is_hermes_pane(id) {
        return send_hermes_text(id, text);
    }
    if managed::is_managed(id) {
        input(id, format!("{text}\r").into_bytes())
    } else {
        crate::tmux::send_keys_to_tui_pane(id, text)
    }
}
pub fn send_keys_to_tui_pane_freetext(id: &str, key: &str, text: &str) -> Result<(), String> {
    if is_hermes_pane(id) {
        if key.starts_with("/answer ") {
            return send_hermes_text(id, &format!("{key}{text}"));
        }
        if let Some(number) = hermes_option_key(key) {
            // Both Hermes interfaces accept arrow navigation. The node TUI's
            // "Other" choice has no numeric shortcut, unlike the classic CLI.
            let index = if number == "0" {
                9
            } else {
                number.parse::<usize>().unwrap_or(1) - 1
            };
            send_key_to_pane_repeated(id, "Up", 10)?;
            send_key_to_pane_repeated(id, "Down", index)?;
            send_key_to_pane(id, "Enter")?;
            std::thread::sleep(std::time::Duration::from_millis(150));
            return send_hermes_text(id, text);
        }
    }
    if !managed::is_managed(id) {
        return crate::tmux::send_keys_to_tui_pane_freetext(id, key, text);
    }
    let mut bytes = key_bytes(key)?;
    bytes.extend_from_slice(text.as_bytes());
    bytes.push(b'\r');
    input(id, bytes)
}

fn is_hermes_pane(id: &str) -> bool {
    pane_pid(id).ok().is_some_and(|pid| {
        crate::agent_session::detect_process_provider(&pid, None)
            == Some(crate::agent_session::ProcessProvider::Hermes)
    })
}

fn send_hermes_text(id: &str, text: &str) -> Result<(), String> {
    if let Some(number) = hermes_option_key(text) {
        return send_literal_to_pane(id, number);
    }
    send_literal_to_pane(id, text)?;
    // Hermes treats Enter within 50ms of a buffer change as a pasted newline.
    // Give its input loop time to consume the text before submitting once.
    std::thread::sleep(std::time::Duration::from_millis(150));
    send_key_to_pane(id, "Enter")
}

fn hermes_option_key(text: &str) -> Option<&str> {
    text.strip_prefix("hermes-option:")
        .filter(|number| number.len() == 1 && number.bytes().all(|byte| byte.is_ascii_digit()))
}
pub fn key_bytes(key: &str) -> Result<Vec<u8>, String> {
    let text = match key {
        "Enter" => "\r",
        "Escape" => "\x1b",
        "Tab" => "\t",
        "BTab" => "\x1b[Z",
        "BSpace" => "\x7f",
        "Up" => "\x1b[A",
        "Down" => "\x1b[B",
        "Right" => "\x1b[C",
        "Left" => "\x1b[D",
        "Home" => "\x1b[H",
        "End" => "\x1b[F",
        "Delete" | "DC" => "\x1b[3~",
        "PPage" => "\x1b[5~",
        "NPage" => "\x1b[6~",
        value if value.starts_with("C-") && value.len() == 3 => {
            return Ok(vec![value.as_bytes()[2].to_ascii_uppercase() & 0x1f])
        }
        value if value.chars().count() == 1 => value,
        _ => return Err(format!("unsupported terminal key: {key}")),
    };
    Ok(text.as_bytes().to_vec())
}
pub fn send_key_to_pane(id: &str, key: &str) -> Result<(), String> {
    if managed::is_managed(id) {
        input(id, key_bytes(key)?)
    } else {
        crate::tmux::send_key_to_pane(id, key)
    }
}
pub fn send_key_to_pane_repeated(id: &str, key: &str, repeat: usize) -> Result<(), String> {
    if managed::is_managed(id) {
        input(id, key_bytes(key)?.repeat(repeat.min(10000)))
    } else {
        crate::tmux::send_key_to_pane_repeated(id, key, repeat)
    }
}
pub fn send_mouse_click_to_pane(id: &str, col: u16, row: u16) -> Result<(), String> {
    if managed::is_managed(id) {
        input(
            id,
            format!(
                "\x1b[<0;{};{}M\x1b[<0;{};{}m",
                col + 1,
                row + 1,
                col + 1,
                row + 1
            )
            .into_bytes(),
        )
    } else {
        crate::tmux::send_mouse_click_to_pane(id, col, row)
    }
}
pub fn send_sigint_to_pane(id: &str) -> Result<(), String> {
    if managed::is_managed(id) {
        input(id, vec![3])
    } else {
        crate::tmux::send_sigint_to_pane(id)
    }
}
pub fn pane_pid(id: &str) -> Result<String, String> {
    if managed::is_managed(id) {
        Ok(info(id)?.child_pid.to_string())
    } else {
        crate::tmux::pane_pid(id)
    }
}
pub fn get_pane_path(id: &str) -> Result<String, String> {
    if managed::is_managed(id) {
        Ok(info(id)?.launch.cwd)
    } else {
        crate::tmux::get_pane_path(id)
    }
}
pub fn pane_exists(id: &str) -> bool {
    if managed::is_managed(id) {
        info(id).is_ok_and(|session| session.status == Status::Running)
    } else {
        crate::tmux::pane_exists(id)
    }
}
pub fn is_pane_busy(session: &str, id: &str) -> bool {
    if managed::is_managed(id) {
        pane_exists(id)
    } else {
        crate::tmux::is_pane_busy(session, id)
    }
}
pub fn pane_process_state(id: &str) -> Result<PaneProcessState, String> {
    if !managed::is_managed(id) {
        return crate::tmux::pane_process_state(id);
    }
    let info = info(id)?;
    Ok(match info.status {
        Status::Running => PaneProcessState::Running,
        Status::Exited => PaneProcessState::Exited(info.exit_code.map(|code| code as i32)),
        Status::Interrupted => PaneProcessState::Missing,
    })
}
pub fn retain_exited_pane(id: &str) -> Result<(), String> {
    if managed::is_managed(id) {
        Ok(())
    } else {
        crate::tmux::retain_exited_pane(id)
    }
}
pub fn kill_pane(id: &str) -> Result<(), String> {
    if managed::is_managed(id) {
        managed::request(id, Request::Stop).map(|_| ())
    } else {
        crate::tmux::kill_pane(id)
    }
}
pub async fn close_pane_gracefully(id: &str) -> Result<(), String> {
    if managed::is_managed(id) {
        kill_pane(id)
    } else {
        crate::tmux::close_pane_gracefully(id).await
    }
}
pub fn display_pane_size(id: &str) -> Result<(u16, u16), String> {
    if !managed::is_managed(id) {
        return crate::tmux::display_pane_size(id);
    }
    let size = snapshot(id)?.size;
    Ok((size.cols, size.rows))
}
pub fn is_active_attached_pane(id: &str) -> Result<bool, String> {
    if !managed::is_managed(id) {
        return crate::tmux::is_active_attached_pane(id);
    }
    let screen = snapshot(id)?;
    Ok(screen.local_attached && screen.control.holder.is_none())
}
pub fn set_pane_title(id: &str, title: &str) -> Result<(), String> {
    if managed::is_managed(id) {
        metadata(id, "title", title)
    } else {
        crate::tmux::set_pane_title(id, title)
    }
}
pub fn set_pane_display_name(id: &str, name: Option<&str>) -> Result<(), String> {
    if managed::is_managed(id) {
        metadata(id, "display_name", name.unwrap_or_default())
    } else {
        crate::tmux::set_pane_display_name(id, name)
    }
}
pub fn clear_pane_display_name(id: &str) -> Result<(), String> {
    set_pane_display_name(id, None)
}
pub fn set_pane_pinned(id: &str, pinned: bool) -> Result<(), String> {
    if managed::is_managed(id) {
        metadata(id, "pinned", if pinned { "1" } else { "0" })
    } else {
        crate::tmux::set_pane_pinned(id, pinned)
    }
}
pub fn set_pane_slug(id: &str, slug: &str) -> Result<(), String> {
    if managed::is_managed(id) {
        metadata(id, "slug", slug)
    } else {
        crate::tmux::set_pane_slug(id, slug)
    }
}
pub fn list_panes_by_slug(slug: &str) -> Result<Vec<(String, u64)>, String> {
    let mut panes = crate::tmux::list_panes_by_slug(slug).unwrap_or_default();
    panes.extend(
        managed::list()?
            .into_iter()
            .filter(|info| {
                info.status == Status::Running
                    && info
                        .launch
                        .metadata
                        .get("slug")
                        .is_some_and(|saved| saved == slug)
            })
            .map(|info| (info.id, u64::from(info.child_pid))),
    );
    Ok(panes)
}
pub fn auto_yes_panes_from_options() -> Result<std::collections::HashSet<String>, String> {
    let mut panes = crate::tmux::auto_yes_panes_from_options().unwrap_or_default();
    panes.extend(
        managed::list()?
            .into_iter()
            .filter(|info| {
                info.status == Status::Running
                    && info
                        .launch
                        .metadata
                        .get("auto_yes")
                        .is_some_and(|value| value == "1")
            })
            .map(|info| info.id),
    );
    Ok(panes)
}
pub fn sync_auto_yes_bell_monitoring(
    panes: &std::collections::HashSet<String>,
) -> Result<(), String> {
    for info in managed::list()? {
        if info.status == Status::Running {
            metadata(
                &info.id,
                "auto_yes",
                if panes.contains(&info.id) { "1" } else { "0" },
            )?;
        }
    }
    let tmux = panes
        .iter()
        .filter(|id| !managed::is_managed(id))
        .cloned()
        .collect();
    if crate::tmux::is_available() {
        crate::tmux::sync_auto_yes_bell_monitoring(&tmux)?;
    }
    Ok(())
}
