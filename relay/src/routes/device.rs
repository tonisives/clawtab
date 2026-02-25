use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct PairRequest {
    pub device_name: String,
}

#[derive(Serialize)]
pub struct PairResponse {
    pub device_id: Uuid,
    pub device_token: String,
}

#[derive(Serialize)]
pub struct DeviceInfo {
    pub id: Uuid,
    pub name: String,
    pub last_seen: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub is_online: bool,
}

pub async fn pair(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<PairRequest>,
) -> Result<Json<PairResponse>, AppError> {
    if req.device_name.trim().is_empty() {
        return Err(AppError::BadRequest("device_name is required".into()));
    }

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use rand::RngCore;

    let mut bytes = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut bytes);
    let device_token = URL_SAFE_NO_PAD.encode(bytes);

    let device_id: Uuid = sqlx::query_scalar(
        "INSERT INTO devices (user_id, name, device_token) VALUES ($1, $2, $3) RETURNING id"
    )
    .bind(claims.sub)
    .bind(req.device_name.trim())
    .bind(&device_token)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(PairResponse {
        device_id,
        device_token,
    }))
}

pub async fn list(
    State(state): State<AppState>,
    claims: Claims,
) -> Result<Json<Vec<DeviceInfo>>, AppError> {
    let rows = sqlx::query_as::<_, (Uuid, String, Option<DateTime<Utc>>, DateTime<Utc>)>(
        "SELECT id, name, last_seen, created_at FROM devices WHERE user_id = $1 ORDER BY created_at"
    )
    .bind(claims.sub)
    .fetch_all(&state.pool)
    .await?;

    let hub = state.hub.read().await;
    let devices: Vec<DeviceInfo> = rows
        .into_iter()
        .map(|(id, name, last_seen, created_at)| {
            let is_online = hub.is_desktop_online(claims.sub, id);
            DeviceInfo { id, name, last_seen, created_at, is_online }
        })
        .collect();

    Ok(Json(devices))
}

pub async fn remove(
    State(state): State<AppState>,
    claims: Claims,
    Path(device_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = sqlx::query("DELETE FROM devices WHERE id = $1 AND user_id = $2")
        .bind(device_id)
        .bind(claims.sub)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("device not found".into()));
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}
