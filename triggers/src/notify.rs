use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sqlx::postgres::PgListener;
use sqlx::PgPool;
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

/// In-process registry of per-trigger-id Notify handles.
/// A waiter calls `subscribe(id)` to get a Notify, then `wait` on it.
/// The single LISTEN task wakes waiters when Postgres notifies trigger_result.
#[derive(Clone)]
pub struct ResultWaiters {
    inner: Arc<Mutex<HashMap<Uuid, Arc<Notify>>>>,
}

impl Default for ResultWaiters {
    fn default() -> Self {
        Self::new()
    }
}

impl ResultWaiters {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub async fn subscribe(&self, id: Uuid) -> Arc<Notify> {
        let mut map = self.inner.lock().await;
        map.entry(id).or_insert_with(|| Arc::new(Notify::new())).clone()
    }

    pub async fn release(&self, id: Uuid) {
        let mut map = self.inner.lock().await;
        if let Some(notify) = map.get(&id) {
            if Arc::strong_count(notify) <= 2 {
                map.remove(&id);
            }
        }
    }

    async fn wake(&self, id: Uuid) {
        let map = self.inner.lock().await;
        if let Some(notify) = map.get(&id) {
            notify.notify_waiters();
        }
    }
}

pub fn spawn_listener(pool: PgPool, waiters: ResultWaiters) {
    tokio::spawn(async move {
        loop {
            match run_listener(&pool, &waiters).await {
                Ok(()) => {
                    tracing::warn!("trigger_result listener exited cleanly; reconnecting");
                }
                Err(e) => {
                    tracing::warn!("trigger_result listener error: {e}; reconnecting in 5s");
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

async fn run_listener(pool: &PgPool, waiters: &ResultWaiters) -> anyhow::Result<()> {
    let mut listener = PgListener::connect_with(pool).await?;
    listener.listen("trigger_result").await?;
    tracing::info!("LISTEN trigger_result");

    loop {
        let notification = listener.recv().await?;
        let payload = notification.payload();
        match Uuid::parse_str(payload) {
            Ok(id) => waiters.wake(id).await,
            Err(_) => tracing::warn!("ignoring malformed trigger_result payload: {payload}"),
        }
    }
}
