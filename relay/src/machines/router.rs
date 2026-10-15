use crate::AppState;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use uuid::Uuid;

pub const CLOSE: &str = "__clawtab_close_connection__";
pub struct Host {
    pub connection: Uuid,
    pub owner: Uuid,
    pub tx: mpsc::Sender<String>,
}
pub struct Client {
    pub managed_sessions: bool,
    pub cancel: std::sync::Arc<tokio::sync::Notify>,
    pub transfers_only: bool,
    pub user: Uuid,
    pub tx: mpsc::Sender<String>,
}
pub struct Pending {
    pub resource: Value,
    pub client: Uuid,
    pub request: String,
    pub machine: Uuid,
    pub since: Instant,
}
pub struct Lease {
    pub client: Uuid,
    pub renewed: Instant,
    pub cols: u32,
    pub rows: u32,
}
#[derive(Default)]
pub struct MachineHub {
    pub journal_pending: HashMap<String, super::journal::Pending>,
    pub hosts: HashMap<Uuid, Host>,
    pub clients: HashMap<Uuid, Client>,
    pub snapshots: HashMap<(Uuid, String), Value>,
    pub pending: HashMap<String, Pending>,
    pub viewers: HashMap<(Uuid, String), HashSet<Uuid>>,
    pub controllers: HashMap<(Uuid, String), Lease>,
    pub run_resources: HashMap<(Uuid, String), Value>,
    pub answered: HashSet<(Uuid, String, String)>,
}
impl MachineHub {
    pub fn online(&self, machine: Uuid) -> bool {
        self.hosts.contains_key(&machine)
    }
    pub fn register(&mut self, machine: Uuid, host: Host) {
        if let Some(old) = self.hosts.insert(machine, host) {
            let _ = old.tx.try_send(CLOSE.into());
        }
    }
    pub fn unregister(&mut self, machine: Uuid, connection: Uuid) {
        if self
            .hosts
            .get(&machine)
            .is_some_and(|h| h.connection == connection)
        {
            self.hosts.remove(&machine);
            self.controllers.retain(|(id, _), _| *id != machine);
        }
    }
    pub fn remove_machine(&mut self, machine: Uuid) {
        if let Some(host) = self.hosts.remove(&machine) {
            let _ = host.tx.try_send(CLOSE.into());
        }
        self.snapshots.retain(|(id, _), _| *id != machine);
        self.viewers.retain(|(id, _), _| *id != machine);
        self.controllers.retain(|(id, _), _| *id != machine);
        self.pending.retain(|_, p| p.machine != machine);
        self.run_resources.retain(|(id, _), _| *id != machine);
        self.answered.retain(|(id, _, _)| *id != machine);
    }
    pub fn disconnect_guests(&mut self) {
        // Closing controller sockets also clears all permission-sensitive state on clients.
        for client in self.clients.values() {
            client.cancel.notify_one();
        }
    }
    pub fn remove_client(&mut self, client: Uuid) {
        self.clients.remove(&client);
        self.pending.retain(|_, p| p.client != client);
        self.controllers.retain(|_, lease| lease.client != client);
        self.viewers.retain(|(machine, pane), viewers| {
            viewers.remove(&client);
            if viewers.is_empty() {
                if let Some(host) = self.hosts.get(machine) {
                    let _ = host
                        .tx
                        .try_send(json!({"type":"unsubscribe_pty","pane_id":pane}).to_string());
                }
                false
            } else {
                true
            }
        });
    }
    pub fn controls(&self, machine: Uuid, pane: &str, client: Uuid) -> bool {
        self.controllers
            .get(&(machine, pane.into()))
            .is_some_and(|l| l.client == client && l.renewed.elapsed() < Duration::from_secs(30))
    }
    pub fn send(&self, client: Uuid, value: &Value) {
        if let Some(c) = self.clients.get(&client) {
            let value = if c.managed_sessions {
                value.clone()
            } else {
                without_managed_sessions(value)
            };
            if c.tx.try_send(value.to_string()).is_err() {
                c.cancel.notify_one();
            }
        }
    }
}

pub fn filtered(value: &Value, groups: Option<&[String]>) -> Option<Value> {
    let Some(groups) = groups else {
        return Some(value.clone());
    };
    let mut out = value.clone();
    let field = match value["type"].as_str()? {
        "detected_processes" => "processes",
        "claude_questions" => "questions",
        "agent_activity" => "activity",
        "jobs_changed" | "jobs_list" => "jobs",
        // Responses are authorized against their requested resource; unsolicited events
        // without a group cannot be exposed to a restricted share.
        _ => return None,
    };
    let items = out[field].as_array_mut()?;
    items.retain(|item| {
        item["matched_group"]
            .as_str()
            .or_else(|| item["group"].as_str())
            .is_some_and(|g| groups.iter().any(|allowed| allowed == g))
    });
    if field == "jobs" {
        let names: HashSet<String> = items
            .iter()
            .filter_map(|v| {
                v["slug"]
                    .as_str()
                    .or_else(|| v["name"].as_str())
                    .map(str::to_owned)
            })
            .collect();
        if let Some(statuses) = out["statuses"].as_object_mut() {
            statuses.retain(|k, _| names.contains(k));
        }
    }
    out.as_object_mut()?.remove("apns_questions");
    Some(out)
}

fn route_peer(hub: &MachineHub, machine: Uuid, connection: Uuid, message: &mut Value) -> bool {
    let Some(target) = message["to"]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
    else {
        return false;
    };
    let Some(source) = hub
        .hosts
        .get(&machine)
        .filter(|host| host.connection == connection)
    else {
        return false;
    };
    let Some(destination) = hub
        .hosts
        .get(&target)
        .filter(|host| host.owner == source.owner && target != machine)
    else {
        return false;
    };
    message["from"] = json!(machine);
    destination.tx.try_send(message.to_string()).is_ok()
}

pub async fn host_event(state: &AppState, machine: Uuid, connection: Uuid, text: &str) {
    if !state
        .machines
        .read()
        .await
        .hosts
        .get(&machine)
        .is_some_and(|h| h.connection == connection)
    {
        return;
    }
    let Ok(mut message) = serde_json::from_str::<Value>(text) else {
        return;
    };
    let Some(kind) = message["type"].as_str().map(str::to_owned) else {
        return;
    };
    if kind == "terminal_control"
        && message["pane_id"]
            .as_str()
            .is_some_and(|pane| pane.starts_with("managed:"))
    {
        let Some(pane) = message["pane_id"].as_str() else {
            return;
        };
        let key = (machine, pane.to_owned());
        let mut hub = state.machines.write().await;
        let previous = hub.controllers.get(&key).map(|lease| lease.client);
        let controller = message["controller"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
            .filter(|id| hub.clients.contains_key(id));
        if let Some(client) = controller {
            hub.controllers.insert(
                key.clone(),
                Lease {
                    client,
                    renewed: Instant::now(),
                    cols: message["cols"].as_u64().unwrap_or(80) as u32,
                    rows: message["rows"].as_u64().unwrap_or(24) as u32,
                },
            );
        } else {
            hub.controllers.remove(&key);
        }
        message["machine_id"] = json!(machine);
        let mut recipients = hub.viewers.get(&key).cloned().unwrap_or_default();
        recipients.extend(previous);
        recipients.extend(controller);
        for client in recipients {
            hub.send(client, &message);
        }
        return;
    }
    if kind == "secure_roster" {
        let Some(id) = message["id"]
            .as_str()
            .filter(|id| Uuid::parse_str(id).is_ok())
        else {
            return;
        };
        let owner = state
            .machines
            .read()
            .await
            .hosts
            .get(&machine)
            .map(|host| host.owner);
        let Some(owner) = owner else {
            return;
        };
        if let Ok(machines) = super::api::list_for(state, owner).await {
            let machines: Vec<Value> = machines
                .as_array()
                .into_iter()
                .flatten()
                .filter(|entry| entry["owned"] == true && entry["id"] != machine.to_string())
                .cloned()
                .collect();
            if let Some(host) = state
                .machines
                .read()
                .await
                .hosts
                .get(&machine)
                .filter(|host| host.connection == connection)
            {
                let _ = host.tx.try_send(
                    json!({"type":"secure_roster_result","id":id,"machines":machines}).to_string(),
                );
            }
        }
        return;
    }
    if kind == "secure_peer" {
        if text.len() > 96 * 1024 {
            return;
        }
        let hub = state.machines.read().await;
        route_peer(&hub, machine, connection, &mut message);
        return;
    }
    // Journal responses are private RPC results, never event broadcasts.
    if message["id"]
        .as_str()
        .is_some_and(|id| id.starts_with("journal:"))
    {
        super::journal::deliver(state, machine, &message).await;
        return;
    }
    if message["id"] == "machine_info" && kind == "host_response" {
        let info = &message["result"];
        let _=sqlx::query("UPDATE devices SET platform=$1,architecture=$2,daemon_version=$3,capabilities=$4 WHERE id=$5")
            .bind(info["platform"].as_str().unwrap_or_default()).bind(info["architecture"].as_str().unwrap_or_default())
            .bind(info["version"].as_str().unwrap_or_default()).bind(&info["capabilities"]).bind(machine).execute(&state.pool).await;
        return;
    }
    let (owner, clients, pending) = {
        let mut hub = state.machines.write().await;
        let Some(host) = hub
            .hosts
            .get(&machine)
            .filter(|h| h.connection == connection)
        else {
            return;
        };
        let owner = host.owner;
        let pending = message["id"].as_str().and_then(|id| hub.pending.remove(id));
        if let Some(run) = message.get("run").filter(|v| v.is_object()) {
            if let Some(id) = run["run_id"].as_str() {
                hub.run_resources.insert((machine, id.into()), run.clone());
            }
        }
        if kind == "run_history" {
            if let Some(pending) = &pending {
                if let Some(runs) = message["runs"].as_array() {
                    for run in runs {
                        if let Some(id) = run["id"].as_str() {
                            hub.run_resources
                                .insert((machine, id.into()), pending.resource.clone());
                        }
                    }
                }
            }
        }
        if kind == "claude_questions" {
            let current = message["questions"].as_array().cloned().unwrap_or_default();
            hub.answered.retain(|(id, pane, question)| {
                *id != machine
                    || current
                        .iter()
                        .any(|q| q["pane_id"] == *pane && q["question_id"] == *question)
            });
            if let Some(questions) = message["questions"].as_array_mut() {
                questions.retain(|q| {
                    !hub.answered.contains(&(
                        machine,
                        q["pane_id"].as_str().unwrap_or_default().into(),
                        q["question_id"].as_str().unwrap_or_default().into(),
                    ))
                });
            }
        }
        if matches!(
            kind.as_str(),
            "jobs_changed"
                | "jobs_list"
                | "detected_processes"
                | "claude_questions"
                | "agent_activity"
                | "auto_yes_panes"
                | "pinned_items"
        ) {
            hub.snapshots.insert(
                (
                    machine,
                    if kind == "jobs_list" {
                        "jobs_changed".into()
                    } else {
                        kind.clone()
                    },
                ),
                message.clone(),
            );
        }
        let clients = hub
            .clients
            .iter()
            .filter(|(_, c)| !c.transfers_only)
            .map(|(id, c)| (*id, c.user))
            .collect::<Vec<_>>();
        (owner, clients, pending)
    };
    if let Some(pending) = pending {
        if pending.machine != machine {
            return;
        }
        let user = state
            .machines
            .read()
            .await
            .clients
            .get(&pending.client)
            .map(|c| c.user);
        if let Some(user) = user {
            if let Ok(grant) = super::access(state, user, machine).await {
                message["id"] = json!(pending.request);
                let payload = if let Some(Some(groups)) = grant {
                    filtered(&message, Some(&groups)).unwrap_or(message)
                } else {
                    message
                };
                state.machines.read().await.send(pending.client,&json!({"type":"machine_event","version":2,"machine_id":machine,"request_id":pending.request,"message":payload}));
            }
        }
        return;
    }
    if kind == "trigger_result" {
        return;
    }
    // Replies to a timed-out or disconnected caller must never become broadcasts.
    if message["id"]
        .as_str()
        .is_some_and(|id| id.starts_with("v2:"))
    {
        return;
    }
    for (client, user) in clients {
        let Ok(grant) = super::access(state, user, machine).await else {
            continue;
        };
        if user != owner
            && matches!(
                kind.as_str(),
                "usage_response" | "settings_response" | "pinned_items" | "host_response"
            )
        {
            continue;
        }
        let payload = match grant.flatten() {
            Some(groups) => {
                let hub = state.machines.read().await;
                filtered(&message, Some(&groups)).or_else(|| {
                    let pane = message["pane_id"]
                        .as_str()
                        .or_else(|| message["run"]["pane_id"].as_str());
                    let name = message["name"].as_str();
                    let visible = pane.is_some_and(|pane| {
                        hub.snapshots
                            .get(&(machine, "detected_processes".into()))
                            .and_then(|v| v["processes"].as_array())
                            .is_some_and(|ps| {
                                ps.iter().any(|p| {
                                    p["pane_id"] == pane
                                        && p["matched_group"].as_str().is_some_and(|g| {
                                            groups.iter().any(|allowed| allowed == g)
                                        })
                                })
                            })
                    }) || name.is_some_and(|name| {
                        hub.snapshots
                            .get(&(machine, "jobs_changed".into()))
                            .and_then(|v| v["jobs"].as_array())
                            .is_some_and(|js| {
                                js.iter().any(|j| {
                                    (j["name"] == name || j["slug"] == name)
                                        && j["group"].as_str().is_some_and(|g| {
                                            groups.iter().any(|allowed| allowed == g)
                                        })
                                })
                            })
                    });
                    visible.then(|| message.clone())
                })
            }
            None => Some(message.clone()),
        };
        let Some(payload) = payload else {
            continue;
        };
        let hub = state.machines.read().await;
        if matches!(kind.as_str(), "pty_output" | "pty_exit") {
            let pane = message["pane_id"].as_str().unwrap_or_default();
            if !hub
                .viewers
                .get(&(machine, pane.into()))
                .is_some_and(|v| v.contains(&client))
            {
                continue;
            }
        }
        hub.send(
            client,
            &json!({"type":"machine_event","version":2,"machine_id":machine,"message":payload}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn peer_frames_require_current_connection_same_owner_and_online_target() {
        let mut hub = MachineHub::default();
        let owner = Uuid::new_v4();
        let source = Uuid::new_v4();
        let target = Uuid::new_v4();
        let connection = Uuid::new_v4();
        let (tx, _source_rx) = mpsc::channel(4);
        let (target_tx, mut target_rx) = mpsc::channel(4);
        hub.register(
            source,
            Host {
                connection,
                owner,
                tx,
            },
        );
        hub.register(
            target,
            Host {
                connection: Uuid::new_v4(),
                owner,
                tx: target_tx,
            },
        );
        let mut frame = json!({"type":"secure_peer","to":target,"from":"forged","data":"opaque"});
        assert!(!route_peer(&hub, source, Uuid::new_v4(), &mut frame));
        assert!(route_peer(&hub, source, connection, &mut frame));
        let forwarded: Value =
            serde_json::from_str(&target_rx.try_recv().unwrap_or_default()).unwrap_or_default();
        assert_eq!(forwarded["from"], json!(source));
        assert_eq!(forwarded["data"], "opaque");
        if let Some(host) = hub.hosts.get_mut(&target) {
            host.owner = Uuid::new_v4();
        }
        assert!(!route_peer(&hub, source, connection, &mut frame));
        hub.hosts.remove(&target);
        assert!(!route_peer(&hub, source, connection, &mut frame));
        frame["to"] = json!(source);
        assert!(!route_peer(&hub, source, connection, &mut frame));
    }
    #[test]
    fn replaced_host_cannot_remove_new_connection() {
        let mut hub = MachineHub::default();
        let machine = Uuid::new_v4();
        let old = Uuid::new_v4();
        let new = Uuid::new_v4();
        let (tx, _) = mpsc::channel(512);
        hub.register(
            machine,
            Host {
                connection: new,
                owner: Uuid::new_v4(),
                tx,
            },
        );
        hub.unregister(machine, old);
        assert!(hub.online(machine));
        hub.unregister(machine, new);
        assert!(!hub.online(machine));
    }
    #[test]
    fn lease_is_machine_scoped() {
        let mut hub = MachineHub::default();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let client = Uuid::new_v4();
        hub.controllers.insert(
            (a, "%1".into()),
            Lease {
                client,
                renewed: Instant::now(),
                cols: 80,
                rows: 24,
            },
        );
        assert!(hub.controls(a, "%1", client));
        assert!(!hub.controls(b, "%1", client));
    }
    #[test]
    fn filters_job_statuses_together() {
        let value = json!({"type":"jobs_changed","jobs":[{"name":"a","group":"one"},{"name":"b","group":"two"}],"statuses":{"a":"idle","b":"running"}});
        let result = filtered(&value, Some(&["one".into()])).unwrap();
        assert_eq!(result["jobs"].as_array().unwrap().len(), 1);
        assert!(result["statuses"].get("b").is_none());
    }
    #[test]
    fn older_clients_keep_tmux_without_managed_resources() {
        let value = json!({"type":"machine_event","message":{
            "processes":[{"pane_id":"%1"},{"pane_id":"managed:example"}],
            "questions":[{"pane_id":"managed:example"}],
            "pane_ids":["%1","managed:example"],
            "items":["pane:%1","pane:managed:example"],
            "statuses":{"job":{"state":"running","pane_id":"managed:example","run_id":"run"}}
        }});
        let filtered = without_managed_sessions(&value);
        assert_eq!(filtered["message"]["processes"], json!([{"pane_id":"%1"}]));
        assert_eq!(filtered["message"]["questions"], json!([]));
        assert_eq!(filtered["message"]["pane_ids"], json!(["%1"]));
        assert_eq!(filtered["message"]["items"], json!(["pane:%1"]));
        assert!(filtered["message"]["statuses"]["job"]
            .get("pane_id")
            .is_none());
        assert_eq!(filtered["message"]["statuses"]["job"]["run_id"], "run");
        assert_eq!(value["message"]["processes"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn capability_filter_preserves_unrelated_envelopes_and_errors() {
        for value in [
            json!({"type":"error","message":"machine is offline"}),
            json!({"type":"secure_message","ciphertext":"opaque","signature":"signature"}),
            json!({"type":"machine_event","message":{"type":"pty_exit","pane_id":"%1"}}),
        ] {
            assert_eq!(without_managed_sessions(&value), value);
        }
    }
}

fn without_managed_sessions(value: &Value) -> Value {
    let mut value = value.clone();
    let payload = if value.get("message").is_some_and(Value::is_object) {
        &mut value["message"]
    } else {
        &mut value
    };
    for field in ["processes", "questions", "activity"] {
        if let Some(items) = payload.get_mut(field).and_then(Value::as_array_mut) {
            items.retain(|item| {
                !item["pane_id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("managed:"))
            });
        }
    }
    for field in ["pane_ids", "items"] {
        if let Some(items) = payload.get_mut(field).and_then(Value::as_array_mut) {
            items.retain(|item| {
                !item
                    .as_str()
                    .is_some_and(|id| id.starts_with("managed:") || id.starts_with("pane:managed:"))
            });
        }
    }
    if let Some(statuses) = payload.get_mut("statuses").and_then(Value::as_object_mut) {
        for status in statuses.values_mut() {
            if status["pane_id"]
                .as_str()
                .is_some_and(|id| id.starts_with("managed:"))
            {
                if let Some(status) = status.as_object_mut() {
                    status.remove("pane_id");
                }
            }
        }
    }
    value
}
