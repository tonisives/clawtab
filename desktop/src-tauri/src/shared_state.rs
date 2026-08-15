use parking_lot::Mutex;
use std::sync::Arc;

use crate::agent_session::{detect_process_provider, ProcessSnapshot};
use crate::config::settings::{normalize_pinned_item_key, normalize_pinned_items, AppSettings};

pub fn set_pinned_item(
    settings: &Arc<Mutex<AppSettings>>,
    key: &str,
    pinned: bool,
) -> Result<Vec<String>, String> {
    let key = normalize_pinned_item_key(key).ok_or_else(|| "invalid pin key".to_string())?;
    let pane_identity = if pinned {
        key.strip_prefix("pane:")
            .map(resolve_pane_pin_identity)
            .transpose()?
    } else {
        None
    };
    if let Some(pane_id) = key.strip_prefix("pane:") {
        if !crate::tmux::pane_exists(pane_id) {
            return Err(format!("tmux pane {pane_id} does not exist"));
        }
        crate::tmux::set_pane_pinned(pane_id, pinned)?;
    }

    let mut guard = settings.lock();
    guard.pinned_items = normalize_pinned_items(std::mem::take(&mut guard.pinned_items));
    let contains = guard.pinned_items.contains(&key);
    if pinned && !contains {
        guard.pinned_items.push(key.clone());
    } else if !pinned && contains {
        guard.pinned_items.retain(|item| item != &key);
    }
    if let Some(pane_id) = key.strip_prefix("pane:") {
        if let Some(identity) = pane_identity {
            guard.pinned_pane_identities.insert(pane_id.to_string(), identity);
        } else {
            guard.pinned_pane_identities.remove(pane_id);
        }
    }
    guard.save()?;
    Ok(guard.pinned_items.clone())
}

pub fn merge_pinned_items(
    settings: &Arc<Mutex<AppSettings>>,
    items: Vec<String>,
) -> Result<Vec<String>, String> {
    let incoming = normalize_pinned_items(items);
    let mut guard = settings.lock();
    guard.pinned_items = normalize_pinned_items(std::mem::take(&mut guard.pinned_items));
    for key in incoming {
        if let Some(pane_id) = key.strip_prefix("pane:") {
            if !crate::tmux::pane_exists(pane_id) {
                continue;
            }
            crate::tmux::set_pane_pinned(pane_id, true)?;
            let identity = resolve_pane_pin_identity(pane_id)?;
            guard.pinned_pane_identities.insert(pane_id.to_string(), identity);
        }
        if !guard.pinned_items.contains(&key) {
            guard.pinned_items.push(key);
        }
    }
    guard.save()?;
    Ok(guard.pinned_items.clone())
}

pub fn get_pinned_items(settings: &Arc<Mutex<AppSettings>>) -> Vec<String> {
    let mut guard = settings.lock();
    let normalized = normalize_pinned_items(guard.pinned_items.clone());
    let mut changed = normalized != guard.pinned_items;
    let mut valid_items = Vec::new();
    for key in normalized {
        let Some(pane_id) = key.strip_prefix("pane:") else {
            valid_items.push(key);
            continue;
        };
        let Ok(identity) = resolve_pane_pin_identity(pane_id) else {
            changed = true;
            continue;
        };
        match guard.pinned_pane_identities.get(pane_id) {
            Some(saved) if saved != &identity => {
                changed = true;
                continue;
            }
            Some(_) => {}
            None => {
                guard
                    .pinned_pane_identities
                    .insert(pane_id.to_string(), identity);
                changed = true;
            }
        }
        valid_items.push(key);
    }
    guard.pinned_items = valid_items;
    let active_panes: std::collections::HashSet<String> = guard
        .pinned_items
        .iter()
        .filter_map(|key| key.strip_prefix("pane:").map(str::to_string))
        .collect();
    guard.pinned_pane_identities.retain(|pane_id, _| active_panes.contains(pane_id));
    if changed {
        let _ = guard.save();
    }
    guard.pinned_items.clone()
}

fn resolve_pane_pin_identity(pane_id: &str) -> Result<String, String> {
    let output = crate::debug_spawn::run_logged(
        "tmux",
        &["display-message", "-t", pane_id, "-p", "#{pid}:#{pane_pid}"],
        "shared_state::resolve_pane_pin_identity",
    )
    .map_err(|error| format!("failed to inspect tmux pane: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "tmux error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let identity = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if identity.is_empty() {
        return Err("tmux returned an empty pane identity".into());
    }
    Ok(identity)
}

pub fn set_pane_display_name(
    settings: &Arc<Mutex<AppSettings>>,
    pane_id: &str,
    display_name: Option<String>,
) -> Result<Option<String>, String> {
    if !crate::tmux::pane_exists(pane_id) {
        return Err(format!("tmux pane {pane_id} does not exist"));
    }
    let display_name = display_name.and_then(normalize_optional_text);
    crate::tmux::set_pane_display_name(pane_id, display_name.as_deref())?;

    let identity = display_name
        .as_ref()
        .map(|_| resolve_process_override_identity(pane_id))
        .transpose()?;
    let mut guard = settings.lock();
    let entry = guard.process_overrides.entry(pane_id.to_string()).or_default();
    entry.display_name = display_name.clone();
    if let Some((pane_pid, session_id)) = identity {
        entry.set_identity(pane_pid, session_id);
    }
    guard.process_overrides.retain(|_, meta| {
        meta.display_name.is_some()
            || meta.first_query.is_some()
            || meta.last_query.is_some()
            || meta.group_override.is_some()
    });
    guard.save()?;
    Ok(display_name)
}

fn normalize_optional_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn resolve_process_override_identity(pane_id: &str) -> Result<(String, Option<String>), String> {
    let output = crate::debug_spawn::run_logged(
        "tmux",
        &[
            "display-message",
            "-t",
            pane_id,
            "-p",
            "#{pane_pid}|CT|#{pane_current_path}",
        ],
        "shared_state::resolve_process_override_identity",
    )
    .map_err(|error| format!("failed to inspect tmux pane: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "tmux error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let (pane_pid, pane_cwd) = raw
        .trim_end()
        .split_once("|CT|")
        .ok_or_else(|| "tmux returned malformed pane identity".to_string())?;
    if pane_pid.is_empty() {
        return Err("tmux returned an empty pane PID".to_string());
    }

    let snapshot = ProcessSnapshot::capture();
    let provider = detect_process_provider(pane_pid, Some(&snapshot));
    let session_id = crate::agent_session::resolve_session_info_for_provider_with_cwd(
        pane_pid,
        provider,
        Some(&snapshot),
        (!pane_cwd.is_empty()).then_some(pane_cwd),
    )
    .session_id;
    Ok((pane_pid.to_string(), session_id))
}
