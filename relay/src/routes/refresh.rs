use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::create_access_token;
use crate::error::AppError;
use crate::routes::register::{create_refresh_token, hash_token, AuthResponse};
use crate::AppState;

#[derive(Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let token_hash = hash_token(&req.refresh_token);

    let row = sqlx::query_as::<_, (Uuid, Uuid, DateTime<Utc>, bool)>(
        "SELECT id, user_id, expires_at, used FROM refresh_tokens WHERE token_hash = $1"
    )
    .bind(&token_hash)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::Unauthorized)?;

    let (token_id, user_id, expires_at, used) = row;

    // Stolen token detection: if already used, revoke all tokens for this user
    if used {
        tracing::warn!("reused refresh token detected for user={user_id}, revoking all tokens");
        sqlx::query("DELETE FROM refresh_tokens WHERE user_id = $1")
            .bind(user_id)
            .execute(&state.pool)
            .await?;
        return Err(AppError::Unauthorized);
    }

    if expires_at < Utc::now() {
        sqlx::query("DELETE FROM refresh_tokens WHERE id = $1")
            .bind(token_id)
            .execute(&state.pool)
            .await?;
        return Err(AppError::Unauthorized);
    }

    // Mark token as used (instead of deleting)
    sqlx::query("UPDATE refresh_tokens SET used = true WHERE id = $1")
        .bind(token_id)
        .execute(&state.pool)
        .await?;

    // Clean up old used tokens (older than 1 hour) to prevent table bloat
    sqlx::query("DELETE FROM refresh_tokens WHERE used = true AND created_at < now() - interval '1 hour'")
        .execute(&state.pool)
        .await
        .ok();

    let user_email: String = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&state.pool)
        .await?;

    let access_token = create_access_token(user_id, &user_email, &state.config.jwt_secret)?;
    let new_refresh_token = create_refresh_token(user_id, &state).await?;

    Ok(Json(AuthResponse {
        user_id,
        access_token,
        refresh_token: new_refresh_token,
    }))
}
