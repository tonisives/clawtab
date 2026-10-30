use super::*;

const EVENTS: &[&str] = &[
    "on_session_start",
    "pre_llm_call",
    "on_human_input_request",
    "on_human_input_resolved",
    "on_session_end",
    "on_session_finalize",
];

pub(super) fn session_key(home: &str, id: &str) -> String {
    super::session_key(ProcessProvider::Hermes, &format!("{home}\0{id}"))
}

pub(super) fn event(name: &str, payload: &Value) -> Option<HookEventV1> {
    let id = payload.get("session_id")?.as_str()?;
    if id.trim().is_empty() || id.len() > 256 {
        return None;
    }
    let home = PathBuf::from(payload.get("clawtab_hermes_home")?.as_str()?);
    if !home.is_absolute() {
        return None;
    }
    let home = home
        .canonicalize()
        .unwrap_or(home)
        .to_string_lossy()
        .into_owned();
    let extra = &payload["extra"];
    let (state, attention, ended) = match name {
        "on_session_start" => (HookAgentState::Idle, None, false),
        "pre_llm_call" | "on_human_input_resolved" => (HookAgentState::Working, None, false),
        "on_human_input_request" => (
            HookAgentState::Waiting,
            Some(if extra["kind"] == "approval" {
                HookAttention::Permission
            } else {
                HookAttention::Question
            }),
            false,
        ),
        // Hermes emits this after EVERY turn, including errors and interruption.
        "on_session_end" => (HookAgentState::Idle, None, false),
        "on_session_finalize" => (HookAgentState::Idle, None, true),
        _ => return None,
    };
    Some(HookEventV1 {
        status_url: None,
        hermes_home: Some(home),
        version: EVENT_VERSION,
        provider: ProcessProvider::Hermes,
        event: name.to_string(),
        session_id: id.to_string(),
        pane_id: None,
        process_id: None,
        cwd: None,
        occurred_at_ms: now_ms(),
        state,
        attention,
        pending_tool: None,
        ended,
    })
}

fn command(event: &str) -> String {
    format!("{} {event}", helper_command(ProcessProvider::Hermes))
}

fn owned(value: &Value) -> bool {
    value
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|value| EVENTS.iter().any(|event| value == command(event)))
}

fn read_config(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value: Value = serde_yml::from_str(&contents)
        .map_err(|_| format!("Invalid Hermes YAML config: {}", path.display()))?;
    if value.is_null() {
        return Ok(json!({}));
    }
    if !value.is_object() {
        return Err("Hermes config must be a mapping".into());
    }
    Ok(value)
}

fn edit_config(root: &mut Value, install: bool) -> Result<(), String> {
    if root.get("hooks").is_none() {
        if !install {
            return Ok(());
        }
        root["hooks"] = json!({});
    }
    let hooks = root["hooks"]
        .as_object_mut()
        .ok_or("Hermes hooks must be a mapping")?;
    for event in EVENTS {
        if !hooks.contains_key(*event) {
            if !install {
                continue;
            }
            hooks.insert(event.to_string(), json!([]));
        }
        let entries = hooks
            .get_mut(*event)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| format!("Hermes hooks.{event} must be a list"))?;
        entries.retain(|entry| !owned(entry));
        if install {
            entries.push(json!({"command": command(event), "timeout": 3}))
        }
        if entries.is_empty() {
            hooks.remove(*event);
        }
    }
    Ok(())
}

fn edit_allowlist(root: &mut Value, install: bool) -> Result<(), String> {
    if root.get("approvals").is_none() {
        root["approvals"] = json!([])
    }
    let entries = root["approvals"]
        .as_array_mut()
        .ok_or("Hermes hook approvals must be a list")?;
    entries.retain(|entry| !owned(entry));
    if install {
        for event in EVENTS {
            entries.push(json!({"event": event, "command": command(event)}))
        }
    }
    Ok(())
}

fn configure(home: &Path, install: bool) -> Result<(), String> {
    let path = home.join("config.yaml");
    let approvals_path = home.join("shell-hooks-allowlist.json");
    let mut config = read_config(&path)?;
    let mut approvals = Value::Object(read_json_object(&approvals_path)?);
    // Validate both before changing either file; preserve every other hook.
    edit_config(&mut config, install)?;
    edit_allowlist(&mut approvals, install)?;
    let yaml = serde_yml::to_string(&config).map_err(|error| error.to_string())?;
    backup_once(&path, path.exists())?;
    backup_once(&approvals_path, approvals_path.exists())?;
    atomic_write(&path, yaml.as_bytes(), 0o600)?;
    atomic_write_json_value(&approvals_path, &approvals)
}

pub(super) fn install(home: &Path) -> Result<(), String> {
    configure(home, true)
}
pub(super) fn remove(home: &Path) -> Result<(), String> {
    configure(home, false)
}

pub(super) fn configured(home: &Path) -> bool {
    read_config(&home.join("config.yaml"))
        .ok()
        .is_some_and(|root| {
            EVENTS.iter().any(|event| {
                root["hooks"][event]
                    .as_array()
                    .is_some_and(|entries| entries.iter().any(owned))
            })
        })
}

pub(super) fn complete(home: &Path) -> bool {
    let Ok(root) = read_config(&home.join("config.yaml")) else {
        return false;
    };
    let approvals = Value::Object(
        read_json_object(&home.join("shell-hooks-allowlist.json")).unwrap_or_default(),
    );
    EVENTS.iter().all(|event| {
        root["hooks"][event].as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry["command"] == command(event))
        }) && approvals["approvals"].as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry["event"] == *event && entry["command"] == command(event))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_repair_remove_preserve_other_hooks_and_settings() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("config.yaml"), "model:\n  default: test/model\nhooks:\n  pre_llm_call:\n    - command: /other/hook\n      timeout: 12\n").unwrap();
        fs::write(
            dir.path().join("shell-hooks-allowlist.json"),
            r#"{"approvals":[{"event":"pre_llm_call","command":"/other/hook"}]}"#,
        )
        .unwrap();
        install(dir.path()).unwrap();
        assert!(complete(dir.path()));
        let first = fs::read(dir.path().join("config.yaml")).unwrap();
        install(dir.path()).unwrap();
        assert_eq!(first, fs::read(dir.path().join("config.yaml")).unwrap());
        remove(dir.path()).unwrap();
        assert!(!configured(dir.path()));
        let root = read_config(&dir.path().join("config.yaml")).unwrap();
        assert_eq!(root["model"]["default"], "test/model");
        assert_eq!(
            root["hooks"]["pre_llm_call"],
            json!([{"command":"/other/hook","timeout":12}])
        );
        let approvals = read_json_object(&dir.path().join("shell-hooks-allowlist.json")).unwrap();
        assert_eq!(
            approvals["approvals"],
            json!([{"event":"pre_llm_call","command":"/other/hook"}])
        );
        assert!(dir.path().join("config.yaml.clawtab-backup").is_file());
    }

    #[test]
    fn malformed_config_and_allowlist_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("config.yaml"), "hooks: broken").unwrap();
        assert!(install(dir.path()).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("config.yaml")).unwrap(),
            "hooks: broken"
        );
        fs::write(dir.path().join("config.yaml"), "model: test").unwrap();
        fs::write(dir.path().join("shell-hooks-allowlist.json"), "broken").unwrap();
        assert!(install(dir.path()).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("config.yaml")).unwrap(),
            "model: test"
        );
    }

    #[test]
    fn shared_gateway_events_bind_by_profile_and_session_only() {
        let runtime = HookRuntime::default();
        runtime
            .hermes_panes
            .lock()
            .insert("%1".into(), session_key("/profiles/a", "same"));
        runtime
            .hermes_panes
            .lock()
            .insert("%2".into(), session_key("/profiles/b", "same"));
        for (home, name) in [
            ("/profiles/a", "pre_llm_call"),
            ("/profiles/b", "on_human_input_request"),
        ] {
            let event = HookEventV1::from_provider_payload(ProcessProvider::Hermes, name,
                &json!({"session_id":"same","clawtab_hermes_home":home,"extra":{"kind":"approval"}}), Some("%999".into()), Some(123)).unwrap();
            assert_eq!(event.pane_id, None);
            assert_eq!(event.process_id, None);
            runtime.apply(event);
        }
        assert_eq!(
            runtime
                .pane_state("%1", ProcessProvider::Hermes)
                .unwrap()
                .state,
            HookAgentState::Working
        );
        assert_eq!(
            runtime
                .pane_state("%2", ProcessProvider::Hermes)
                .unwrap()
                .state,
            HookAgentState::Waiting
        );
        assert!(runtime
            .pane_state("%999", ProcessProvider::Hermes)
            .is_none());
        let end = event("on_session_end", &json!({"session_id":"same","clawtab_hermes_home":"/profiles/a","extra":{"interrupted":true}})).unwrap();
        assert!(!end.ended);
        runtime.apply(end);
        assert_eq!(
            runtime
                .pane_state("%1", ProcessProvider::Hermes)
                .unwrap()
                .state,
            HookAgentState::Idle
        );
        runtime.retain_live_panes(
            &HashSet::from(["%1".into(), "%2".into()]),
            &HashSet::new(),
            &HashSet::from(["%2".into()]),
        );
        assert!(runtime.pane_state("%1", ProcessProvider::Hermes).is_none());
    }
}
