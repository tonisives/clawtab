use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;
use uuid::Uuid;

const SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct AuthResult {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: Uuid,
}

struct Session {
    result: Option<AuthResult>,
    created: Instant,
}

pub struct AuthSessionStore {
    sessions: RwLock<HashMap<String, Session>>,
}

impl AuthSessionStore {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    pub async fn create(&self, id: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.insert(
            id.to_string(),
            Session {
                result: None,
                created: Instant::now(),
            },
        );
    }

    pub async fn complete(&self, id: &str, result: AuthResult) {
        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(id) {
            session.result = Some(result);
        }
    }

    pub async fn poll(&self, id: &str) -> Option<Option<AuthResult>> {
        let sessions = self.sessions.read().await;
        sessions.get(id).map(|s| s.result.clone())
    }

    pub async fn remove(&self, id: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.remove(id);
    }

    async fn cleanup(&self) {
        let mut sessions = self.sessions.write().await;
        sessions.retain(|_, s| s.created.elapsed() < SESSION_TTL);
    }
}

pub fn spawn_cleanup(store: Arc<AuthSessionStore>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(CLEANUP_INTERVAL).await;
            store.cleanup().await;
        }
    });
}
