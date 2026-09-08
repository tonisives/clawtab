use crate::{auth::Claims, error::AppError, AppState};
use axum::{
    extract::{Path, State},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

fn token() -> String {
    let mut bytes = [0; 48];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

#[derive(Deserialize)]
pub struct Begin {
    name: String,
    platform: String,
    architecture: String,
}
pub async fn begin_pairing(
    State(state): State<AppState>,
    Json(req): Json<Begin>,
) -> Result<Json<Value>, AppError> {
    if req.name.trim().is_empty()
        || req.name.len() > 100
        || req.platform.len() > 32
        || req.architecture.len() > 32
    {
        return Err(AppError::BadRequest("invalid machine details".into()));
    }
    let id = Uuid::new_v4();
    let secret = token();
    let code = Uuid::new_v4().simple().to_string()[..10].to_uppercase();
    sqlx::query("DELETE FROM machine_pairings WHERE expires_at < now()")
        .execute(&state.pool)
        .await?;
    sqlx::query("INSERT INTO machine_pairings (id, code, poll_hash, name, platform, architecture) VALUES ($1,$2,$3,$4,$5,$6)")
        .bind(id).bind(&code).bind(hash(&secret)).bind(req.name.trim()).bind(req.platform).bind(req.architecture)
        .execute(&state.pool).await?;
    Ok(Json(
        json!({"pairing_id":id,"code":code,"poll_token":secret,"expires_in":600,"interval":10}),
    ))
}
#[derive(Deserialize)]
pub struct Approve {
    code: String,
}
pub async fn approve_pairing(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<Approve>,
) -> Result<Json<Value>, AppError> {
    let code = req.code.replace([' ', '-'], "").to_uppercase();
    let updated = sqlx::query("UPDATE machine_pairings SET owner_id=$1 WHERE code=$2 AND expires_at > now() AND owner_id IS NULL AND NOT consumed")
        .bind(claims.sub).bind(code).execute(&state.pool).await?;
    if updated.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "code expired or already approved".into(),
        ));
    }
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct Poll {
    pairing_id: Uuid,
    poll_token: String,
}
pub async fn poll_pairing(
    State(state): State<AppState>,
    Json(req): Json<Poll>,
) -> Result<Json<Value>, AppError> {
    let mut tx = state.pool.begin().await?;
    let row: Option<(Option<Uuid>, String, String, String)> = sqlx::query_as(
        "SELECT owner_id,name,platform,architecture FROM machine_pairings WHERE id=$1 AND poll_hash=$2 AND expires_at > now() AND NOT consumed FOR UPDATE")
        .bind(req.pairing_id).bind(hash(&req.poll_token)).fetch_optional(&mut *tx).await?;
    let Some((owner, name, platform, architecture)) = row else {
        return Err(AppError::Unauthorized);
    };
    let Some(owner) = owner else {
        return Ok(Json(json!({"status":"pending"})));
    };
    let device = Uuid::new_v4();
    let credential = token();
    sqlx::query("INSERT INTO devices (id,user_id,name,device_token,platform,architecture) VALUES ($1,$2,$3,$4,$5,$6)")
        .bind(device).bind(owner).bind(name).bind(&credential).bind(platform).bind(architecture).execute(&mut *tx).await?;
    sqlx::query("UPDATE machine_pairings SET consumed=true WHERE id=$1")
        .bind(req.pairing_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    // Legacy sockets must not continue with an ambiguous machine list.
    super::disconnect_legacy_owner(&state, owner).await;
    Ok(Json(
        json!({"status":"paired","device_id":device,"device_token":credential}),
    ))
}

pub async fn list(State(state): State<AppState>, claims: Claims) -> Result<Json<Value>, AppError> {
    list_for(&state, claims.sub).await.map(Json)
}
pub async fn list_for(state: &AppState, user: Uuid) -> Result<Value, AppError> {
    let rows: Vec<(Uuid, Uuid, String, String, String, String, Value, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(
        "SELECT d.id,d.user_id,d.name,d.platform,d.architecture,d.daemon_version,d.capabilities,d.last_seen FROM devices d WHERE d.user_id=$1 OR EXISTS (SELECT 1 FROM machine_grants g JOIN workspace_shares s ON s.id=g.share_id WHERE g.device_id=d.id AND s.guest_id=$1) ORDER BY d.created_at")
        .bind(user).fetch_all(&state.pool).await?;
    let hub = state.machines.read().await;
    Ok(Value::Array(rows.into_iter().map(|(id, owner, name, platform, architecture, version, capabilities, last_seen)| {
        json!({"id":id,"name":name,"owner_id":owner,"owned":owner==user,"platform":platform,"architecture":architecture,"version":version,"capabilities":capabilities,"last_seen":last_seen,"online":hub.online(id),"connection_id":hub.hosts.get(&id).map(|host|host.connection)})
    }).collect()))
}
#[derive(Deserialize)]
pub struct Grant {
    share_id: Uuid,
}
pub async fn grant(
    State(state): State<AppState>,
    claims: Claims,
    Path(machine): Path<Uuid>,
    Json(req): Json<Grant>,
) -> Result<Json<Value>, AppError> {
    if super::access(&state, claims.sub, machine).await?.is_some() {
        return Err(AppError::Forbidden);
    }
    let changed = sqlx::query("INSERT INTO machine_grants (device_id,share_id) SELECT $1,id FROM workspace_shares WHERE id=$2 AND owner_id=$3 ON CONFLICT DO NOTHING")
        .bind(machine).bind(req.share_id).bind(claims.sub).execute(&state.pool).await?;
    Ok(Json(json!({"ok":changed.rows_affected()==1})))
}
pub async fn revoke_grant(
    State(state): State<AppState>,
    claims: Claims,
    Path(machine): Path<Uuid>,
    Json(req): Json<Grant>,
) -> Result<Json<Value>, AppError> {
    if super::access(&state, claims.sub, machine).await?.is_some() {
        return Err(AppError::Forbidden);
    }
    sqlx::query("DELETE FROM machine_grants WHERE device_id=$1 AND share_id=$2")
        .bind(machine)
        .bind(req.share_id)
        .execute(&state.pool)
        .await?;
    state.machines.write().await.disconnect_guests();
    super::disconnect_legacy_owner(&state, claims.sub).await;
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
pub struct PushToken {
    push_token: String,
    platform: String,
}
pub async fn push_token(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<PushToken>,
) -> Result<Json<Value>, AppError> {
    if req.push_token.len() > 512 || !matches!(req.platform.as_str(), "ios" | "android") {
        return Err(AppError::BadRequest("invalid push registration".into()));
    }
    sqlx::query("INSERT INTO push_tokens (user_id,push_token,platform) VALUES ($1,$2,$3) ON CONFLICT (push_token) DO UPDATE SET user_id=$1,platform=$3,updated_at=now()")
        .bind(claims.sub).bind(req.push_token).bind(req.platform).execute(&state.pool).await?;
    Ok(Json(json!({"ok":true})))
}

pub async fn grants(
    State(state): State<AppState>,
    claims: Claims,
    Path(machine): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    if super::access(&state, claims.sub, machine).await?.is_some() {
        return Err(AppError::Forbidden);
    }
    let rows:Vec<(Uuid,String,bool)>=sqlx::query_as("SELECT s.id,u.email,EXISTS(SELECT 1 FROM machine_grants g WHERE g.share_id=s.id AND g.device_id=$1) FROM workspace_shares s JOIN users u ON u.id=s.guest_id WHERE s.owner_id=$2 ORDER BY u.email").bind(machine).bind(claims.sub).fetch_all(&state.pool).await?;
    Ok(Json(
        json!({"shares":rows.into_iter().map(|(id,email,granted)|json!({"id":id,"email":email,"granted":granted})).collect::<Vec<_>>()}),
    ))
}
