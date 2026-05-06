use axum::extract::{Path, State};
use axum::Json;
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::api_token::{hash_token, TOKEN_PREFIX};
use crate::auth::Claims;
use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct CreateRequest {
    pub name: String,
    pub expires_in_days: Option<i64>,
}

#[derive(Serialize)]
pub struct CreateResponse {
    pub id: Uuid,
    pub name: String,
    pub prefix: String,
    pub secret: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct TokenSummary {
    pub id: Uuid,
    pub name: String,
    pub prefix: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

fn generate_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    format!("{TOKEN_PREFIX}{encoded}")
}

pub async fn create(
    State(state): State<AppState>,
    claims: Claims,
    Json(body): Json<CreateRequest>,
) -> Result<Json<CreateResponse>, AppError> {
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("name must not be empty".into()));
    }
    let expires_at = body.expires_in_days.map(|d| Utc::now() + Duration::days(d));

    let secret = generate_secret();
    let token_hash = hash_token(&secret);
    let prefix: String = secret.chars().take(12).collect();

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(claims.sub)
    .bind(&body.name)
    .bind(&token_hash)
    .bind(&prefix)
    .bind(expires_at)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(CreateResponse {
        id,
        name: body.name,
        prefix,
        secret,
        created_at: Utc::now(),
        expires_at,
    }))
}

pub async fn list(
    State(state): State<AppState>,
    claims: Claims,
) -> Result<Json<Vec<TokenSummary>>, AppError> {
    let rows: Vec<(
        Uuid,
        String,
        String,
        DateTime<Utc>,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
    )> = sqlx::query_as(
        "SELECT id, name, prefix, created_at, last_used_at, expires_at, revoked_at
         FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC",
    )
    .bind(claims.sub)
    .fetch_all(&state.pool)
    .await?;

    let out = rows.into_iter().map(|(id, name, prefix, created_at, last_used_at, expires_at, revoked_at)| TokenSummary {
        id, name, prefix, created_at, last_used_at, expires_at, revoked_at,
    }).collect();

    Ok(Json(out))
}

pub async fn revoke(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let res = sqlx::query(
        "UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(id)
    .bind(claims.sub)
    .execute(&state.pool)
    .await?;

    if res.rows_affected() == 0 {
        return Err(AppError::NotFound("token not found".into()));
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}
