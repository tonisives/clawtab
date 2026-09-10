use crate::{error::AppError, AppState};
use uuid::Uuid;

pub async fn host_allowed(state: &AppState, owner: Uuid, machine: Uuid) -> Result<bool, AppError> {
    let rental: Option<bool> = sqlx::query_scalar("SELECT r.user_id IS NOT NULL AND r.state IN ('provisioning','ready') AND (r.delete_at IS NULL OR r.delete_at>now()) AND (r.paid_until>now() OR (NOT r.cancel_requested AND r.unpaid_since IS NOT NULL AND r.unpaid_since+interval '10 days'>now())) FROM rentals r WHERE r.device_id=$1")
        .bind(machine).fetch_optional(&state.pool).await?;
    match rental {
        Some(allowed) => Ok(allowed),
        None => crate::billing::is_subscribed(&state.pool, &state.config, owner).await,
    }
}
pub async fn can_connect(state: &AppState, user: Uuid) -> Result<bool, AppError> {
    crate::billing::is_subscribed(&state.pool, &state.config, user).await
}
pub async fn watch(state: AppState) {
    let mut timer = tokio::time::interval(std::time::Duration::from_secs(15));
    loop {
        timer.tick().await;
        let hosts: Vec<(Uuid, Uuid)> = state
            .machines
            .read()
            .await
            .hosts
            .iter()
            .map(|(id, host)| (*id, host.owner))
            .collect();
        for (machine, owner) in hosts {
            match host_allowed(&state, owner, machine).await {
                Ok(true) => {
                    let _ = sqlx::query("UPDATE devices SET last_seen=now() WHERE id=$1")
                        .bind(machine)
                        .execute(&state.pool)
                        .await;
                }
                Ok(false) => {
                    state.machines.write().await.remove_machine(machine);
                    state.hub.write().await.disconnect_device(owner, machine);
                }
                Err(error) => tracing::error!("rental access check failed: {error}"),
            }
        }
        // Reconnect clears cached snapshots/leases when an account loses its
        // relay entitlement, including the last eligible rental.
        let clients: Vec<(Uuid, Uuid)> = state
            .machines
            .read()
            .await
            .clients
            .iter()
            .map(|(id, client)| (*id, client.user))
            .collect();
        for (id, user) in clients {
            if matches!(can_connect(&state, user).await, Ok(false)) {
                if let Some(client) = state.machines.read().await.clients.get(&id) {
                    client.cancel.notify_one();
                }
            }
        }
    }
}
