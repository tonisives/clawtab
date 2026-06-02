use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tokio::sync::mpsc;
use uuid::Uuid;

use clawtab_protocol::{
    ClaudeQuestion, ClientMessage, DesktopMessage, DetectedProcess, ServerMessage,
};

pub struct DesktopConnection {
    pub device_id: Uuid,
    pub device_name: String,
    pub tx: mpsc::UnboundedSender<String>,
}

pub struct MobileConnection {
    pub connection_id: Uuid,
    pub tx: mpsc::UnboundedSender<String>,
}

/// Central in-memory router for all live WebSocket connections.
///
/// One Hub instance per process, shared behind a `RwLock`. Read paths
/// (every forwarded message) take the read lock; only connect/disconnect
/// take the write lock.
pub struct Hub {
    desktops: HashMap<Uuid, Vec<DesktopConnection>>,
    mobiles: HashMap<Uuid, Vec<MobileConnection>>,
    /// Cached questions per user, replayed to newly connecting mobiles
    /// and to guests of shared workspaces.
    last_questions: HashMap<Uuid, Vec<ClaudeQuestion>>,
    /// Pane IDs with auto-yes enabled per user (suppresses push notifications).
    auto_yes_panes: HashMap<Uuid, HashSet<String>>,
    /// Raw JSON of the last AutoYesPanes message, replayed verbatim to mobiles.
    last_auto_yes_panes: HashMap<Uuid, String>,
    /// Last daemon/Desktop process snapshot per user, replayed to mobiles.
    last_detected_processes: HashMap<Uuid, Vec<DetectedProcess>>,
}

impl Hub {
    pub fn new() -> Self {
        Self {
            desktops: HashMap::new(),
            mobiles: HashMap::new(),
            last_questions: HashMap::new(),
            auto_yes_panes: HashMap::new(),
            last_auto_yes_panes: HashMap::new(),
            last_detected_processes: HashMap::new(),
        }
    }

    pub fn add_desktop(&mut self, user_id: Uuid, conn: DesktopConnection) {
        let device_id = conn.device_id;
        let device_name = conn.device_name.clone();

        let conns = self.desktops.entry(user_id).or_default();
        conns.retain(|existing| existing.device_id != device_id);
        conns.push(conn);

        self.broadcast_to_mobiles(
            user_id,
            &ServerMessage::DesktopStatus {
                device_id: device_id.to_string(),
                device_name,
                online: true,
            },
        );
    }

    pub fn remove_desktop(&mut self, user_id: Uuid, device_id: Uuid) {
        let Some(conns) = self.desktops.get_mut(&user_id) else {
            return;
        };

        let Some(idx) = conns.iter().position(|c| c.device_id == device_id) else {
            return;
        };

        let removed = conns.swap_remove(idx);
        let no_desktops = conns.is_empty();

        if no_desktops {
            self.desktops.remove(&user_id);
            self.last_questions.remove(&user_id);
            self.last_detected_processes.remove(&user_id);
            self.broadcast_to_mobiles(
                user_id,
                &DesktopMessage::ClaudeQuestions {
                    questions: vec![],
                    apns_questions: None,
                },
            );
            self.broadcast_to_mobiles(
                user_id,
                &DesktopMessage::DetectedProcesses {
                    id: "desktop_offline".to_string(),
                    processes: vec![],
                },
            );
        }

        self.broadcast_to_mobiles(
            user_id,
            &ServerMessage::DesktopStatus {
                device_id: device_id.to_string(),
                device_name: removed.device_name,
                online: false,
            },
        );
    }

    pub fn add_mobile(&mut self, user_id: Uuid, conn: MobileConnection) {
        if let Some(desktops) = self.desktops.get(&user_id) {
            for desktop in desktops {
                send_serialized(
                    &conn.tx,
                    &ServerMessage::DesktopStatus {
                        device_id: desktop.device_id.to_string(),
                        device_name: desktop.device_name.clone(),
                        online: true,
                    },
                );
            }
        }

        if let Some(questions) = self.last_questions.get(&user_id) {
            send_serialized(
                &conn.tx,
                &DesktopMessage::ClaudeQuestions {
                    questions: questions.clone(),
                    apns_questions: None,
                },
            );
        }

        if let Some(json) = self.last_auto_yes_panes.get(&user_id) {
            let _ = conn.tx.send(json.clone());
        }

        if let Some(processes) = self.last_detected_processes.get(&user_id) {
            send_serialized(
                &conn.tx,
                &DesktopMessage::DetectedProcesses {
                    id: "cached_processes".to_string(),
                    processes: processes.clone(),
                },
            );
        }

        self.mobiles.entry(user_id).or_default().push(conn);
    }

    pub fn remove_mobile(&mut self, user_id: Uuid, connection_id: Uuid) {
        let Some(conns) = self.mobiles.get_mut(&user_id) else {
            return;
        };
        conns.retain(|c| c.connection_id != connection_id);
        if conns.is_empty() {
            self.mobiles.remove(&user_id);
        }
    }

    /// Forward a client (mobile) message to the user's desktop app(s).
    /// Returns true if at least one desktop received it.
    pub fn forward_to_desktop(&self, user_id: Uuid, msg: &ClientMessage) -> bool {
        let Ok(json) = serde_json::to_string(msg) else {
            return false;
        };

        let Some(conns) = self.desktops.get(&user_id) else {
            return false;
        };

        let mut sent = false;
        for conn in conns {
            sent |= conn.tx.send(json.clone()).is_ok();
        }
        sent
    }

    /// Send any serializable message to all mobile clients for a user.
    pub fn broadcast_to_mobiles<T: Serialize>(&self, user_id: Uuid, msg: &T) {
        let Ok(json) = serde_json::to_string(msg) else {
            return;
        };
        self.send_raw_to_mobiles(user_id, &json);
    }

    /// Send a raw JSON string to all mobile clients (avoids re-serialization).
    pub fn send_raw_to_mobiles(&self, user_id: Uuid, json: &str) {
        let Some(conns) = self.mobiles.get(&user_id) else {
            return;
        };
        for conn in conns {
            let _ = conn.tx.send(json.to_string());
        }
    }

    pub fn has_desktop(&self, user_id: Uuid) -> bool {
        self.desktops
            .get(&user_id)
            .is_some_and(|conns| !conns.is_empty())
    }

    pub fn is_desktop_online(&self, user_id: Uuid, device_id: Uuid) -> bool {
        self.desktops
            .get(&user_id)
            .is_some_and(|conns| conns.iter().any(|c| c.device_id == device_id))
    }

    pub fn set_cached_questions(&mut self, user_id: Uuid, questions: Vec<ClaudeQuestion>) {
        self.last_questions.insert(user_id, questions);
    }

    pub fn set_cached_auto_yes_panes_json(&mut self, user_id: Uuid, json: &str) {
        self.last_auto_yes_panes.insert(user_id, json.to_string());
    }

    pub fn set_cached_detected_processes(
        &mut self,
        user_id: Uuid,
        processes: Vec<DetectedProcess>,
    ) {
        self.last_detected_processes.insert(user_id, processes);
    }

    pub fn cached_detected_processes(&self, user_id: Uuid) -> Vec<DetectedProcess> {
        self.last_detected_processes
            .get(&user_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn set_auto_yes_panes(&mut self, user_id: Uuid, pane_ids: HashSet<String>) {
        if pane_ids.is_empty() {
            self.auto_yes_panes.remove(&user_id);
        } else {
            self.auto_yes_panes.insert(user_id, pane_ids);
        }
    }

    pub fn is_auto_yes_pane(&self, user_id: Uuid, pane_id: &str) -> bool {
        self.auto_yes_panes
            .get(&user_id)
            .is_some_and(|panes| panes.contains(pane_id))
    }

    /// Replay desktop status and cached state for `owner_id` to a single sender.
    /// Used when a mobile guest connects to a workspace shared by `owner_id`.
    pub fn replay_desktop_state_to(
        &self,
        owner_id: Uuid,
        tx: &mpsc::UnboundedSender<String>,
        allowed_groups: Option<&[String]>,
    ) {
        if let Some(desktops) = self.desktops.get(&owner_id) {
            for desktop in desktops {
                send_serialized(
                    tx,
                    &ServerMessage::DesktopStatus {
                        device_id: desktop.device_id.to_string(),
                        device_name: desktop.device_name.clone(),
                        online: true,
                    },
                );
            }
        }
        if let Some(questions) = self.last_questions.get(&owner_id) {
            let questions = match allowed_groups {
                Some(groups) => questions
                    .iter()
                    .filter(|q| {
                        q.matched_group
                            .as_ref()
                            .is_some_and(|group| groups.iter().any(|allowed| allowed == group))
                    })
                    .cloned()
                    .collect(),
                None => questions.clone(),
            };
            send_serialized(
                tx,
                &DesktopMessage::ClaudeQuestions {
                    questions,
                    apns_questions: None,
                },
            );
        }
        if let Some(json) = self.last_auto_yes_panes.get(&owner_id) {
            let _ = tx.send(json.clone());
        }
    }
}

fn send_serialized<T: Serialize>(tx: &mpsc::UnboundedSender<String>, msg: &T) {
    if let Ok(json) = serde_json::to_string(msg) {
        let _ = tx.send(json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clawtab_protocol::QuestionOption;

    fn mk_channel() -> (
        mpsc::UnboundedSender<String>,
        mpsc::UnboundedReceiver<String>,
    ) {
        mpsc::unbounded_channel()
    }

    fn mk_question(pane: &str) -> ClaudeQuestion {
        ClaudeQuestion {
            pane_id: pane.to_string(),
            cwd: "/tmp".to_string(),
            tmux_session: String::new(),
            window_name: String::new(),
            question_id: format!("q-{pane}"),
            context_lines: String::new(),
            options: vec![QuestionOption {
                number: "1".to_string(),
                label: "Yes".to_string(),
                selected: false,
                col: 0,
            }],
            input_mode: String::new(),
            button_row: 0,
            matched_group: None,
            matched_job: None,
        }
    }

    #[test]
    fn add_remove_desktop_tracks_presence() {
        let mut hub = Hub::new();
        let user = Uuid::new_v4();
        let device = Uuid::new_v4();
        let (tx, _rx) = mk_channel();

        assert!(!hub.has_desktop(user));
        hub.add_desktop(
            user,
            DesktopConnection {
                device_id: device,
                device_name: "laptop".into(),
                tx,
            },
        );
        assert!(hub.has_desktop(user));

        hub.remove_desktop(user, device);
        assert!(!hub.has_desktop(user));
    }

    #[test]
    fn add_mobile_replays_desktop_status_and_questions() {
        let mut hub = Hub::new();
        let user = Uuid::new_v4();
        let device = Uuid::new_v4();
        let conn_id = Uuid::new_v4();

        let (desktop_tx, _desktop_rx) = mk_channel();
        hub.add_desktop(
            user,
            DesktopConnection {
                device_id: device,
                device_name: "laptop".into(),
                tx: desktop_tx,
            },
        );
        hub.set_cached_questions(user, vec![mk_question("pane-1")]);

        let (mobile_tx, mut mobile_rx) = mk_channel();
        hub.add_mobile(
            user,
            MobileConnection {
                connection_id: conn_id,
                tx: mobile_tx,
            },
        );

        let first = mobile_rx.try_recv().unwrap_or_default();
        assert!(first.contains("desktop_status"), "got {first}");
        let second = mobile_rx.try_recv().unwrap_or_default();
        assert!(second.contains("claude_questions"), "got {second}");
    }

    #[test]
    fn replay_desktop_state_filters_questions_by_group() {
        let mut hub = Hub::new();
        let owner = Uuid::new_v4();
        let device = Uuid::new_v4();
        let (desktop_tx, _desktop_rx) = mk_channel();
        hub.add_desktop(
            owner,
            DesktopConnection {
                device_id: device,
                device_name: "laptop".into(),
                tx: desktop_tx,
            },
        );

        let mut allowed = mk_question("allowed");
        allowed.matched_group = Some("work".into());
        let mut denied = mk_question("denied");
        denied.matched_group = Some("private".into());
        hub.set_cached_questions(owner, vec![allowed, denied]);

        let (tx, mut rx) = mk_channel();
        hub.replay_desktop_state_to(owner, &tx, Some(&["work".into()]));

        let _status = rx.try_recv().unwrap_or_default();
        let questions = rx.try_recv().unwrap_or_default();
        assert!(questions.contains("q-allowed"), "got {questions}");
        assert!(!questions.contains("q-denied"), "got {questions}");
    }

    #[test]
    fn forward_to_desktop_returns_false_when_no_desktop() {
        let hub = Hub::new();
        let user = Uuid::new_v4();
        let msg = ClientMessage::ListJobs { id: "x".into() };
        assert!(!hub.forward_to_desktop(user, &msg));
    }

    #[test]
    fn forward_to_desktop_delivers_when_present() {
        let mut hub = Hub::new();
        let user = Uuid::new_v4();
        let (tx, mut rx) = mk_channel();
        hub.add_desktop(
            user,
            DesktopConnection {
                device_id: Uuid::new_v4(),
                device_name: "laptop".into(),
                tx,
            },
        );

        let msg = ClientMessage::ListJobs { id: "x".into() };
        assert!(hub.forward_to_desktop(user, &msg));
        let delivered = rx.try_recv().unwrap_or_default();
        assert!(delivered.contains("list_jobs"), "got {delivered}");
    }

    #[test]
    fn add_desktop_replaces_same_device_connection() {
        let mut hub = Hub::new();
        let user = Uuid::new_v4();
        let device = Uuid::new_v4();
        let (old_tx, mut old_rx) = mk_channel();
        let (new_tx, mut new_rx) = mk_channel();

        hub.add_desktop(
            user,
            DesktopConnection {
                device_id: device,
                device_name: "laptop".into(),
                tx: old_tx,
            },
        );
        hub.add_desktop(
            user,
            DesktopConnection {
                device_id: device,
                device_name: "laptop".into(),
                tx: new_tx,
            },
        );

        let msg = ClientMessage::ListJobs { id: "x".into() };
        assert!(hub.forward_to_desktop(user, &msg));
        assert!(old_rx.try_recv().is_err());
        let delivered = new_rx.try_recv().unwrap_or_default();
        assert!(delivered.contains("list_jobs"), "got {delivered}");
    }

    #[test]
    fn forward_to_desktop_sends_to_all_connections() {
        let mut hub = Hub::new();
        let user = Uuid::new_v4();
        let (tx1, mut rx1) = mk_channel();
        let (tx2, mut rx2) = mk_channel();

        hub.add_desktop(
            user,
            DesktopConnection {
                device_id: Uuid::new_v4(),
                device_name: "laptop-1".into(),
                tx: tx1,
            },
        );
        hub.add_desktop(
            user,
            DesktopConnection {
                device_id: Uuid::new_v4(),
                device_name: "laptop-2".into(),
                tx: tx2,
            },
        );

        let msg = ClientMessage::ListJobs { id: "x".into() };
        assert!(hub.forward_to_desktop(user, &msg));
        assert!(rx1.try_recv().unwrap_or_default().contains("list_jobs"));
        assert!(rx2.try_recv().unwrap_or_default().contains("list_jobs"));
    }

    #[test]
    fn auto_yes_panes_set_and_clear() {
        let mut hub = Hub::new();
        let user = Uuid::new_v4();

        assert!(!hub.is_auto_yes_pane(user, "pane-1"));

        let mut panes = HashSet::new();
        panes.insert("pane-1".to_string());
        hub.set_auto_yes_panes(user, panes);
        assert!(hub.is_auto_yes_pane(user, "pane-1"));
        assert!(!hub.is_auto_yes_pane(user, "pane-2"));

        hub.set_auto_yes_panes(user, HashSet::new());
        assert!(!hub.is_auto_yes_pane(user, "pane-1"));
    }
}
