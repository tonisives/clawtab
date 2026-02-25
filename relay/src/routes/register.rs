use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{create_access_token, hash_password};
use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub user_id: Uuid,
    pub access_token: String,
    pub refresh_token: String,
}

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let email = req.email.trim().to_lowercase();

    if email.is_empty() || !email.contains('@') {
        return Err(AppError::BadRequest("invalid email".into()));
    }
    if req.password.len() < 8 {
        return Err(AppError::BadRequest("password must be at least 8 characters".into()));
    }

    let password_hash = hash_password(&req.password)?;

    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id"
    )
    .bind(&email)
    .bind(&password_hash)
    .bind(&req.display_name)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db_err) if db_err.is_unique_violation() => {
            AppError::Conflict("email already registered".into())
        }
        other => AppError::Sqlx(other),
    })?;

    let access_token = create_access_token(user_id, &email, &state.config.jwt_secret)?;
    let refresh_token = create_refresh_token(user_id, &state).await?;

    Ok(Json(AuthResponse {
        user_id,
        access_token,
        refresh_token,
    }))
}

pub async fn create_refresh_token(user_id: Uuid, state: &AppState) -> Result<String, AppError> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use rand::RngCore;

    let mut bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);

    let token_hash = hash_token(&token);
    let expires_at = chrono::Utc::now() + chrono::Duration::days(30);

    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)"
    )
    .bind(user_id)
    .bind(&token_hash)
    .bind(expires_at)
    .execute(&state.pool)
    .await?;

    Ok(token)
}

/// Hash a refresh token for storage using SHA-256.
/// Refresh tokens are already high-entropy random bytes, so a fast hash is sufficient.
pub fn hash_token(token: &str) -> String {
    use sha2::{Sha256, Digest};
    let hash = Sha256::digest(token.as_bytes());
    hex::encode(hash)
}
