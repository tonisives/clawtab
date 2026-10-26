use super::{store::Store, types::*};
use crate::ipc::AgentActivity;
use serde_json::json;
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct AlertChanges {
    pub created: Vec<NfnRecord>,
    pub changed: bool,
}

pub(super) fn sync(
    store: &Store,
    activity: &[AgentActivity],
    seen: &mut HashMap<String, String>,
    source: impl Fn(&str) -> NfnSource,
) -> Result<AlertChanges, String> {
    let active: HashMap<_, _> = activity
        .iter()
        .filter_map(|item| {
            item.alert
                .as_deref()
                .filter(|body| !body.trim().is_empty())
                .map(|body| (item.pane_id.as_str(), body))
        })
        .collect();
    seen.retain(|pane, _| active.contains_key(pane.as_str()));
    let mut changes = AlertChanges::default();
    let mut pending = HashMap::new();
    for mut record in store.pending()? {
        if record.request.data["event"] != "agent_alert" {
            continue;
        }
        let Some(pane) = record.request.source.pane_id.clone() else {
            continue;
        };
        if active.contains_key(pane.as_str()) {
            pending.insert(pane, record);
        } else {
            record.status = "resolved".into();
            store.save(&mut record)?;
            changes.changed = true;
        }
    }
    for (pane, body) in active {
        if seen.get(pane).is_some_and(|previous| previous == body) {
            continue;
        }
        if let Some(mut record) = pending.remove(pane) {
            if record.request.body != body {
                record.request.body = body.into();
                store.save(&mut record)?;
                changes.changed = true;
            }
        } else {
            let source = source(pane);
            let title = source
                .task
                .clone()
                .filter(|task| !task.is_empty())
                .or_else(|| {
                    source.cwd.as_deref().and_then(|cwd| {
                        std::path::Path::new(cwd)
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                    })
                })
                .unwrap_or_else(|| "Agent alert".into());
            let (record, created) = store.send(
                NfnRequest {
                    title,
                    body: body.into(),
                    template: "update".into(),
                    data: json!({"event":"agent_alert"}),
                    source,
                    dedupe_key: Some("agent-alert".into()),
                    actions: vec![NfnAction {
                        id: "focus".into(),
                        label: "Open session".into(),
                        kind: "focus".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                None,
            )?;
            if created {
                changes.created.push(record);
                changes.changed = true;
            }
        }
        seen.insert(pane.into(), body.into());
    }
    Ok(changes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn activity(body: Option<&str>) -> Vec<AgentActivity> {
        vec![AgentActivity {
            pane_id: "%1".into(),
            last_action_at_ms: None,
            working: body.is_none(),
            asking: false,
            alert: body.map(str::to_owned),
        }]
    }

    fn source(pane: &str) -> NfnSource {
        NfnSource {
            pane_id: Some(pane.into()),
            session_id: Some("session-1".into()),
            cwd: Some("/workspace/project".into()),
            ..Default::default()
        }
    }

    #[test]
    fn alerts_notify_once_update_in_place_and_resolve_on_recovery_or_exit() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("notifications.sqlite")).unwrap();
        let mut seen = HashMap::new();
        let failure = activity(Some(
            "Selected model is at capacity. Please try a different model.",
        ));
        let created = sync(&store, &failure, &mut seen, source).unwrap().created;
        assert_eq!(created.len(), 1);
        let id = &created[0].id;
        assert_eq!(created[0].request.title, "project");
        assert_eq!(created[0].request.actions[0].kind, "focus");
        assert!(created[0].question_id.is_none());
        assert!(!sync(&store, &failure, &mut seen, source).unwrap().changed);

        let changed = activity(Some("Connection failed.\nCodex session file is 590 MB."));
        let update = sync(&store, &changed, &mut seen, source).unwrap();
        assert!(update.changed);
        assert!(update.created.is_empty());
        assert_eq!(store.pending().unwrap().len(), 1);
        assert_eq!(
            store.get(id).unwrap().request.body,
            changed[0].alert.as_deref().unwrap()
        );

        // Restarting the daemon must reuse its persisted alert.
        let restarted = sync(&store, &changed, &mut HashMap::new(), source).unwrap();
        assert!(restarted.created.is_empty());
        sync(&store, &activity(None), &mut seen, source).unwrap();
        assert_eq!(store.get(id).unwrap().status, "resolved");
        assert_eq!(
            sync(&store, &failure, &mut seen, source)
                .unwrap()
                .created
                .len(),
            1
        );
        sync(&store, &[], &mut seen, source).unwrap();
        assert!(store.pending().unwrap().is_empty());
    }

    #[test]
    fn dismissed_alerts_stay_dismissed_until_the_next_failure() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("notifications.sqlite")).unwrap();
        let mut seen = HashMap::new();
        let failure = activity(Some("Selected model is at capacity."));
        let mut record = sync(&store, &failure, &mut seen, source)
            .unwrap()
            .created
            .remove(0);
        record.dismissed_at = Some(now());
        store.save(&mut record).unwrap();
        let changed = activity(Some(
            "Selected model is at capacity.\nCodex session file is 591 MB.",
        ));
        assert!(sync(&store, &changed, &mut seen, source)
            .unwrap()
            .created
            .is_empty());
        assert_eq!(
            store.get(&record.id).unwrap().dismissed_at,
            record.dismissed_at
        );
        assert_eq!(store.pending_count().unwrap(), 0);
    }
}
