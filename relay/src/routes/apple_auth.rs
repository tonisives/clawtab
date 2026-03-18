use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::apple::{verify_apple_token, AppleUserInfo};
use crate::auth::create_access_token;
use crate::error::AppError;
use crate::routes::register::{create_refresh_token, AuthResponse};
use crate::AppState;

#[derive(Deserialize)]
pub struct AppleAuthRequest {
    pub id_token: String,
    /// Full name from Apple (only sent on first sign-in)
    pub display_name: Option<String>,
    /// Email from Apple (only sent on first sign-in)
    pub email: Option<String>,
}

/// Shared logic: find or create a user from Apple info, issue tokens.
pub async fn authenticate_apple_user(
    state: &AppState,
    info: &AppleUserInfo,
    req_display_name: Option<&str>,
    req_email: Option<&str>,
) -> Result<AuthResponse, AppError> {
    // Prefer email from verified token, fall back to request body (first sign-in only)
    let email = info.email.as_deref()
        .or(req_email)
        .map(|e| e.trim().to_lowercase());

    // Check if user exists by apple_id
    let existing_by_apple: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id, email FROM users WHERE apple_id = $1"
    )
    .bind(&info.sub)
    .fetch_optional(&state.pool)
    .await?;

    if let Some((user_id, user_email)) = existing_by_apple {
        let access_token = create_access_token(user_id, &user_email, &state.config.jwt_secret)?;
        let refresh_token = create_refresh_token(user_id, state).await?;
        return Ok(AuthResponse { user_id, access_token, refresh_token });
    }

    // Check if user exists by email (link Apple to existing account)
    if let Some(ref email) = email {
        let existing_by_email: Option<(Uuid, String)> = sqlx::query_as(
            "SELECT id, email FROM users WHERE email = $1"
        )
        .bind(email)
        .fetch_optional(&state.pool)
        .await?;

        if let Some((user_id, user_email)) = existing_by_email {
            sqlx::query("UPDATE users SET apple_id = $1, updated_at = now() WHERE id = $2")
                .bind(&info.sub)
                .bind(user_id)
                .execute(&state.pool)
                .await?;

            let access_token = create_access_token(user_id, &user_email, &state.config.jwt_secret)?;
            let refresh_token = create_refresh_token(user_id, state).await?;
            return Ok(AuthResponse { user_id, access_token, refresh_token });
        }
    }

    // New user - create account
    let user_email = email
        .ok_or_else(|| AppError::BadRequest("email is required for new accounts".into()))?;

    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (email, apple_id, display_name) VALUES ($1, $2, $3) RETURNING id"
    )
    .bind(&user_email)
    .bind(&info.sub)
    .bind(req_display_name)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db_err) if db_err.is_unique_violation() => {
            AppError::Conflict("account already exists".into())
        }
        other => AppError::Sqlx(other),
    })?;

    let access_token = create_access_token(user_id, &user_email, &state.config.jwt_secret)?;
    let refresh_token = create_refresh_token(user_id, state).await?;

    Ok(AuthResponse { user_id, access_token, refresh_token })
}

pub async fn apple_auth(
    State(state): State<AppState>,
    Json(req): Json<AppleAuthRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let apple_client_id = state.config.apple_client_id.as_deref()
        .unwrap_or("cc.clawtab");
    let info = verify_apple_token(&req.id_token, apple_client_id).await?;
    let resp = authenticate_apple_user(
        &state,
        &info,
        req.display_name.as_deref(),
        req.email.as_deref(),
    ).await?;
    Ok(Json(resp))
}
