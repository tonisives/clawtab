use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::{create_access_token, verify_password};
use crate::error::AppError;
use crate::routes::register::{create_refresh_token, AuthResponse};
use crate::AppState;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let email = req.email.trim().to_lowercase();

    let row = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT id, email, password_hash FROM users WHERE email = $1"
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::Unauthorized)?;

    let (user_id, user_email, password_hash) = row;

    if !verify_password(&req.password, &password_hash)? {
        return Err(AppError::Unauthorized);
    }

    let access_token = create_access_token(user_id, &user_email, &state.config.jwt_secret)?;
    let refresh_token = create_refresh_token(user_id, &state).await?;

    Ok(Json(AuthResponse {
        user_id,
        access_token,
        refresh_token,
    }))
}
