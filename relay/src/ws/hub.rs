use std::collections::HashMap;

use tokio::sync::mpsc;
use uuid::Uuid;

use clawtab_protocol::{ClientMessage, DesktopMessage, ServerMessage};

/// A connected desktop app.
pub struct DesktopConnection {
    pub device_id: Uuid,
    pub device_name: String,
    pub tx: mpsc::UnboundedSender<String>,
}

/// A connected mobile/web client.
pub struct MobileConnection {
    pub connection_id: Uuid,
    pub tx: mpsc::UnboundedSender<String>,
}

/// Central hub that tracks all active WebSocket connections and routes messages.
pub struct Hub {
    /// user_id -> desktop connections
    desktops: HashMap<Uuid, Vec<DesktopConnection>>,
    /// user_id -> mobile connections
    mobiles: HashMap<Uuid, Vec<MobileConnection>>,
}

impl Hub {
    pub fn new() -> Self {
        Self {
            desktops: HashMap::new(),
            mobiles: HashMap::new(),
        }
    }

    pub fn add_desktop(&mut self, user_id: Uuid, conn: DesktopConnection) {
        let device_id = conn.device_id;
        let device_name = conn.device_name.clone();

        self.desktops.entry(user_id).or_default().push(conn);

        // Notify mobile clients that a desktop came online
        self.send_to_mobiles(user_id, &ServerMessage::DesktopStatus {
            device_id: device_id.to_string(),
            device_name,
            online: true,
        });
    }

    pub fn remove_desktop(&mut self, user_id: Uuid, device_id: Uuid) {
        if let Some(conns) = self.desktops.get_mut(&user_id) {
            let device_name = conns.iter()
                .find(|c| c.device_id == device_id)
                .map(|c| c.device_name.clone())
                .unwrap_or_default();

            conns.retain(|c| c.device_id != device_id);
            if conns.is_empty() {
                self.desktops.remove(&user_id);
            }

            self.send_to_mobiles(user_id, &ServerMessage::DesktopStatus {
                device_id: device_id.to_string(),
                device_name,
                online: false,
            });
        }
    }

    pub fn add_mobile(&mut self, user_id: Uuid, conn: MobileConnection) {
        // Send current desktop status to the newly connected mobile
        if let Some(desktops) = self.desktops.get(&user_id) {
            for desktop in desktops {
                if let Ok(json) = serde_json::to_string(&ServerMessage::DesktopStatus {
                    device_id: desktop.device_id.to_string(),
                    device_name: desktop.device_name.clone(),
                    online: true,
                }) {
                    let _ = conn.tx.send(json);
                }
            }
        }

        self.mobiles.entry(user_id).or_default().push(conn);
    }

    pub fn remove_mobile(&mut self, user_id: Uuid, connection_id: Uuid) {
        if let Some(conns) = self.mobiles.get_mut(&user_id) {
            conns.retain(|c| c.connection_id != connection_id);
            if conns.is_empty() {
                self.mobiles.remove(&user_id);
            }
        }
    }

    /// Forward a client (mobile) message to the user's desktop app(s).
    pub fn forward_to_desktop(&self, user_id: Uuid, msg: &ClientMessage) -> bool {
        let Ok(json) = serde_json::to_string(msg) else {
            return false;
        };

        if let Some(conns) = self.desktops.get(&user_id) {
            let mut sent = false;
            for conn in conns {
                if conn.tx.send(json.clone()).is_ok() {
                    sent = true;
                }
            }
            sent
        } else {
            false
        }
    }

    /// Forward a desktop message to all connected mobile clients for this user.
    pub fn forward_to_mobiles(&self, user_id: Uuid, msg: &DesktopMessage) {
        let Ok(json) = serde_json::to_string(msg) else {
            return;
        };

        if let Some(conns) = self.mobiles.get(&user_id) {
            for conn in conns {
                let _ = conn.tx.send(json.clone());
            }
        }
    }

    pub fn is_desktop_online(&self, user_id: Uuid, device_id: Uuid) -> bool {
        self.desktops
            .get(&user_id)
            .is_some_and(|conns| conns.iter().any(|c| c.device_id == device_id))
    }

    pub fn has_desktop(&self, user_id: Uuid) -> bool {
        self.desktops
            .get(&user_id)
            .is_some_and(|conns| !conns.is_empty())
    }

    /// Send a raw JSON string to all mobile clients for a user.
    pub fn send_raw_to_mobiles(&self, user_id: Uuid, json: &str) {
        if let Some(conns) = self.mobiles.get(&user_id) {
            for conn in conns {
                let _ = conn.tx.send(json.to_string());
            }
        }
    }

    fn send_to_mobiles(&self, user_id: Uuid, msg: &ServerMessage) {
        let Ok(json) = serde_json::to_string(msg) else {
            return;
        };

        if let Some(conns) = self.mobiles.get(&user_id) {
            for conn in conns {
                let _ = conn.tx.send(json.clone());
            }
        }
    }
}
