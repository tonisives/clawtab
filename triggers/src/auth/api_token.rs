use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::middleware::Next;
use axum::response::Response;
use chrono::Utc;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::AppError;
use crate::AppState;

pub const TOKEN_PREFIX: &str = "ctk_";

#[derive(Debug, Clone)]
pub struct ApiTokenUser {
    pub user_id: Uuid,
    #[allow(dead_code)]
    pub token_id: Uuid,
}

pub fn hash_token(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hex::encode(hasher.finalize())
}

pub async fn api_token_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let header = req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    let token = header.ok_or(AppError::Unauthorized)?;
    if !token.starts_with(TOKEN_PREFIX) {
        return Err(AppError::Unauthorized);
    }

    let token_hash = hash_token(token);
    let row: Option<(Uuid, Uuid, Option<chrono::DateTime<Utc>>, Option<chrono::DateTime<Utc>>)> = sqlx::query_as(
        "SELECT id, user_id, expires_at, revoked_at FROM api_tokens WHERE token_hash = $1",
    )
    .bind(&token_hash)
    .fetch_optional(&state.pool)
    .await?;

    let (token_id, user_id, expires_at, revoked_at) = row.ok_or(AppError::Unauthorized)?;

    if revoked_at.is_some() {
        return Err(AppError::Unauthorized);
    }
    if let Some(exp) = expires_at {
        if exp < Utc::now() {
            return Err(AppError::Unauthorized);
        }
    }

    sqlx::query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1")
        .bind(token_id)
        .execute(&state.pool)
        .await
        .ok();

    req.extensions_mut().insert(ApiTokenUser { user_id, token_id });
    Ok(next.run(req).await)
}

impl<S> FromRequestParts<S> for ApiTokenUser
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts.extensions.get::<ApiTokenUser>()
            .cloned()
            .ok_or(AppError::Unauthorized)
    }
}
