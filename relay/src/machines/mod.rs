pub mod api;
mod router;
mod socket;
pub use router::host_event;
pub use router::MachineHub;
pub use socket::connect;

use crate::{error::AppError, AppState};
use uuid::Uuid;

/// None means owner; Some contains the existing share's group restriction.
pub async fn access(
    state: &AppState,
    user: Uuid,
    machine: Uuid,
) -> Result<Option<Option<Vec<String>>>, AppError> {
    let owner: Option<Uuid> = sqlx::query_scalar("SELECT user_id FROM devices WHERE id = $1")
        .bind(machine)
        .fetch_optional(&state.pool)
        .await?;
    if owner == Some(user) {
        return Ok(None);
    }
    let groups: Option<(Option<Vec<String>>,)> = sqlx::query_as(
        "SELECT s.allowed_groups FROM machine_grants g JOIN workspace_shares s ON s.id = g.share_id WHERE g.device_id = $1 AND s.guest_id = $2")
        .bind(machine).bind(user).fetch_optional(&state.pool).await?;
    groups.map(|row| Some(row.0)).ok_or(AppError::Forbidden)
}

pub use router::{Host, CLOSE};

pub async fn legacy_machine(state: &AppState, user: Uuid) -> Result<(Uuid, Uuid), AppError> {
    let devices:Vec<(Uuid,Uuid)>=sqlx::query_as("SELECT d.user_id,d.id FROM devices d WHERE d.user_id=$1 OR EXISTS (SELECT 1 FROM machine_grants g JOIN workspace_shares s ON s.id=g.share_id WHERE g.device_id=d.id AND s.guest_id=$1)")
        .bind(user).fetch_all(&state.pool).await?;
    if devices.len() != 1 {
        return Err(AppError::Conflict(
            "upgrade the client to select a machine".into(),
        ));
    }
    let (owner, machine) = devices[0];
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM devices WHERE user_id=$1")
        .bind(owner)
        .fetch_one(&state.pool)
        .await?;
    if count != 1 {
        return Err(AppError::Conflict(
            "upgrade the client to select a machine".into(),
        ));
    }
    Ok((owner, machine))
}

pub async fn disconnect_legacy_owner(state: &AppState, owner: Uuid) {
    let guests: Vec<Uuid> =
        sqlx::query_scalar("SELECT guest_id FROM workspace_shares WHERE owner_id=$1")
            .bind(owner)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();
    let mut hub = state.hub.write().await;
    hub.disconnect_mobiles(owner);
    for guest in guests {
        hub.disconnect_mobiles(guest);
    }
}
