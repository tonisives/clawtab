//! Restricted HTTP-to-machine RPC. Journal tokens are not login or device tokens.
use crate::{auth::Claims, error::AppError, AppState};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use clawtab_protocol::JournalQuery;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct TokenRow {
    id: Uuid,
    label: String,
    created_at: chrono::DateTime<chrono::Utc>,
    revoked_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub fn owner_routes() -> axum::Router<AppState> {
    use axum::routing::{delete, get};
    axum::Router::new()
        .route("/machines/{id}/journal-tokens", get(list).post(create))
        .route("/machines/{machine}/journal-tokens/{id}", delete(revoke))
}

pub struct Pending {
    pub machine: Uuid,
    pub since: Instant,
    pub sender: oneshot::Sender<Value>,
}

fn digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

#[derive(Deserialize)]
pub struct Create {
    label: String,
}

pub async fn create(
    State(state): State<AppState>,
    claims: Claims,
    Path(machine): Path<Uuid>,
    Json(input): Json<Create>,
) -> Result<Json<Value>, AppError> {
    if super::access(&state, claims.sub, machine).await?.is_some() {
        return Err(AppError::Forbidden);
    }
    if input.label.trim().is_empty() || input.label.len() > 100 {
        return Err(AppError::BadRequest("A token label is required".into()));
    }
    let mut bytes = [0_u8; 48];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = format!("wj_{}", URL_SAFE_NO_PAD.encode(bytes));
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO journal_tokens(id,owner_id,machine_id,label,token_hash) VALUES($1,$2,$3,$4,$5)")
        .bind(id).bind(claims.sub).bind(machine).bind(input.label.trim()).bind(digest(&token)).execute(&state.pool).await?;
    Ok(Json(
        json!({"id":id,"machine_id":machine,"token":token,"scope":"journal:query"}),
    ))
}

pub async fn list(
    State(state): State<AppState>,
    claims: Claims,
    Path(machine): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    if super::access(&state, claims.sub, machine).await?.is_some() {
        return Err(AppError::Forbidden);
    }
    let rows:Vec<TokenRow>=sqlx::query_as("SELECT id,label,created_at,revoked_at FROM journal_tokens WHERE machine_id=$1 AND owner_id=$2 ORDER BY created_at DESC")
        .bind(machine).bind(claims.sub).fetch_all(&state.pool).await?;
    Ok(Json(json!(rows.into_iter().map(|row|json!({"id":row.id,"label":row.label,"created_at":row.created_at,"revoked_at":row.revoked_at})).collect::<Vec<_>>())))
}

pub async fn revoke(
    State(state): State<AppState>,
    claims: Claims,
    Path((machine, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, AppError> {
    let changed=sqlx::query("UPDATE journal_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND machine_id=$2 AND owner_id=$3").bind(id).bind(machine).bind(claims.sub).execute(&state.pool).await?;
    if changed.rows_affected() != 1 {
        return Err(AppError::NotFound("Journal token not found".into()));
    }
    Ok(Json(json!({"revoked":true})))
}

pub async fn query(
    State(state): State<AppState>,
    Path(machine): Path<Uuid>,
    headers: HeaderMap,
    Json(query): Json<JournalQuery>,
) -> Result<Json<Value>, AppError> {
    query.validate().map_err(AppError::BadRequest)?;
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.starts_with("wj_") && s.len() <= 200)
        .ok_or(AppError::Unauthorized)?;
    let hash = digest(token);
    let owner:Option<Uuid>=sqlx::query_scalar("SELECT t.owner_id FROM journal_tokens t JOIN devices d ON d.id=t.machine_id AND d.user_id=t.owner_id WHERE t.token_hash=$1 AND t.machine_id=$2 AND t.revoked_at IS NULL").bind(&hash).bind(machine).fetch_optional(&state.pool).await?;
    let owner = owner.ok_or(AppError::Unauthorized)?;
    if super::access(&state, owner, machine).await?.is_some() {
        return Err(AppError::Forbidden);
    }
    let capabilities: Value = sqlx::query_scalar("SELECT capabilities FROM devices WHERE id=$1")
        .bind(machine)
        .fetch_one(&state.pool)
        .await?;
    if !capabilities
        .as_array()
        .is_some_and(|v| v.iter().any(|c| c == "journal_query_v1"))
    {
        return Err(AppError::Conflict(
            "Update Clawtab on this machine to enable journal queries".into(),
        ));
    }
    let id = format!("journal:{}", Uuid::new_v4());
    let (sender, receiver) = oneshot::channel();
    {
        let mut hub = state.machines.write().await;
        hub.journal_pending
            .retain(|_, p| p.since.elapsed() < Duration::from_secs(8));
        if hub
            .journal_pending
            .values()
            .filter(|p| p.machine == machine)
            .count()
            >= 4
        {
            return Err(AppError::RateLimited);
        }
        let host = hub
            .hosts
            .get(&machine)
            .ok_or_else(|| AppError::Conflict("Journal machine is offline".into()))?;
        host.tx.try_send(json!({"type":"host_request","id":id,"request":{"action":"journal_context","query":query}}).to_string()).map_err(|_|AppError::Conflict("Journal machine is busy".into()))?;
        hub.journal_pending.insert(
            id.clone(),
            Pending {
                machine,
                since: Instant::now(),
                sender,
            },
        );
    }
    let result = tokio::time::timeout(Duration::from_secs(6), receiver).await;
    state.machines.write().await.journal_pending.remove(&id);
    let message = result
        .map_err(|_| AppError::Conflict("Journal query timed out".into()))?
        .map_err(|_| AppError::Conflict("Journal machine disconnected".into()))?;
    // A token may be revoked while a request is in flight.
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM journal_tokens WHERE token_hash=$1 AND machine_id=$2 AND revoked_at IS NULL)").bind(hash).bind(machine).fetch_one(&state.pool).await?;
    if !active {
        return Err(AppError::Unauthorized);
    }
    if message.get("error").is_some() {
        return Err(AppError::Conflict("Local journal is unavailable".into()));
    }
    let result = &message["result"];
    if result["version"] != 1 || !approved_context(result) {
        return Err(AppError::Conflict("Invalid journal response".into()));
    }
    Ok(Json(result.clone()))
}

fn approved_context(value: &Value) -> bool {
    [("facts", 3), ("writing_examples", 6)]
        .into_iter()
        .all(|(key, max)| {
            value[key].as_array().is_some_and(|items| {
                items.len() <= max && items.iter().all(|i| i["status"] == "approved")
            })
        })
}

pub async fn deliver(state: &AppState, machine: Uuid, message: &Value) {
    let Some(id) = message["id"].as_str() else {
        return;
    };
    let mut hub = state.machines.write().await;
    if hub
        .journal_pending
        .get(id)
        .is_some_and(|p| p.machine == machine)
    {
        if let Some(pending) = hub.journal_pending.remove(id) {
            let _ = pending.sender.send(message.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_material_is_rejected() {
        assert!(approved_context(&json!({"facts":[],"writing_examples":[]})));
        assert!(!approved_context(
            &json!({"facts":[{"status":"pending"}],"writing_examples":[]})
        ));
        assert!(!approved_context(
            &json!({"facts":[],"writing_examples":null})
        ));
    }
}
