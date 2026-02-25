use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::google::{verify_google_token, GoogleUserInfo};
use crate::auth::create_access_token;
use crate::error::AppError;
use crate::routes::register::{create_refresh_token, AuthResponse};
use crate::AppState;

#[derive(Deserialize)]
pub struct GoogleAuthRequest {
    pub id_token: String,
}

/// Shared logic: find or create a user from Google info, issue tokens.
pub async fn authenticate_google_user(
    state: &AppState,
    info: &GoogleUserInfo,
) -> Result<AuthResponse, AppError> {
    let email = info.email.trim().to_lowercase();

    // Check if user exists by google_id
    let existing_by_google: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id, email FROM users WHERE google_id = $1"
    )
    .bind(&info.sub)
    .fetch_optional(&state.pool)
    .await?;

    if let Some((user_id, user_email)) = existing_by_google {
        let access_token = create_access_token(user_id, &user_email, &state.config.jwt_secret)?;
        let refresh_token = create_refresh_token(user_id, state).await?;
        return Ok(AuthResponse { user_id, access_token, refresh_token });
    }

    // Check if user exists by email (link Google to existing account)
    let existing_by_email: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id, email FROM users WHERE email = $1"
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;

    if let Some((user_id, user_email)) = existing_by_email {
        sqlx::query("UPDATE users SET google_id = $1, updated_at = now() WHERE id = $2")
            .bind(&info.sub)
            .bind(user_id)
            .execute(&state.pool)
            .await?;

        let access_token = create_access_token(user_id, &user_email, &state.config.jwt_secret)?;
        let refresh_token = create_refresh_token(user_id, state).await?;
        return Ok(AuthResponse { user_id, access_token, refresh_token });
    }

    // New user - create account
    let display_name = info.name.clone();
    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (email, google_id, display_name) VALUES ($1, $2, $3) RETURNING id"
    )
    .bind(&email)
    .bind(&info.sub)
    .bind(&display_name)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db_err) if db_err.is_unique_violation() => {
            AppError::Conflict("account already exists".into())
        }
        other => AppError::Sqlx(other),
    })?;

    let access_token = create_access_token(user_id, &email, &state.config.jwt_secret)?;
    let refresh_token = create_refresh_token(user_id, state).await?;

    Ok(AuthResponse { user_id, access_token, refresh_token })
}

pub async fn google_auth(
    State(state): State<AppState>,
    Json(req): Json<GoogleAuthRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let google_client_id = state.config.google_client_id.as_deref();
    let info = verify_google_token(&req.id_token, google_client_id).await?;
    let resp = authenticate_google_user(&state, &info).await?;
    Ok(Json(resp))
}
