use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::auth::create_access_token;
use crate::error::AppError;
use crate::routes::register::{hash_token, new_refresh_token, AuthResponse};
use crate::AppState;

const REFRESH_RETRY_GRACE_SECONDS: i64 = 30;

#[derive(Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let token_hash = hash_token(&req.refresh_token);
    let mut transaction = state.pool.begin().await?;

    let Some(user_id) = consume_refresh_token(&mut transaction, &token_hash).await? else {
        transaction.commit().await?;
        return Err(AppError::Unauthorized);
    };

    sqlx::query("DELETE FROM refresh_tokens WHERE used_at < now() - interval '1 hour'")
        .execute(&mut *transaction)
        .await
        .ok();

    let user_email: String = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&mut *transaction)
        .await?;

    let access_token = create_access_token(user_id, &user_email, &state.config.jwt_secret)?;
    let (new_refresh_token, new_token_hash, new_expires_at) = new_refresh_token();
    sqlx::query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(new_token_hash)
        .bind(new_expires_at)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;

    Ok(Json(AuthResponse {
        user_id,
        access_token,
        refresh_token: new_refresh_token,
    }))
}

async fn consume_refresh_token(
    transaction: &mut Transaction<'_, Postgres>,
    token_hash: &str,
) -> Result<Option<Uuid>, AppError> {
    let row = sqlx::query_as::<_, (Uuid, Uuid, DateTime<Utc>, bool, Option<DateTime<Utc>>)>(
        "SELECT id, user_id, expires_at, used, used_at
         FROM refresh_tokens
         WHERE token_hash = $1
         FOR UPDATE",
    )
    .bind(token_hash)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(AppError::Unauthorized)?;

    let (token_id, user_id, expires_at, used, used_at) = row;
    let now = Utc::now();

    if expires_at < now {
        sqlx::query("DELETE FROM refresh_tokens WHERE id = $1")
            .bind(token_id)
            .execute(&mut **transaction)
            .await?;
        return Ok(None);
    }

    if !used {
        sqlx::query("UPDATE refresh_tokens SET used = true, used_at = $2 WHERE id = $1")
            .bind(token_id)
            .bind(now)
            .execute(&mut **transaction)
            .await?;
        return Ok(Some(user_id));
    }

    if is_within_retry_grace(used_at, now) {
        tracing::info!("allowing refresh token retry within grace period for user={user_id}");
        return Ok(Some(user_id));
    }

    tracing::warn!("reused refresh token detected for user={user_id}, revoking all tokens");
    sqlx::query("DELETE FROM refresh_tokens WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut **transaction)
        .await?;
    Ok(None)
}

fn is_within_retry_grace(used_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    used_at.is_some_and(|used_at| {
        used_at >= now - chrono::Duration::seconds(REFRESH_RETRY_GRACE_SECONDS)
    })
}

#[cfg(test)]
mod tests {
    use super::{is_within_retry_grace, REFRESH_RETRY_GRACE_SECONDS};
    use chrono::{Duration, Utc};

    #[test]
    fn allows_immediate_refresh_retry() {
        let now = Utc::now();
        let used_at = now - Duration::seconds(REFRESH_RETRY_GRACE_SECONDS - 1);

        assert!(is_within_retry_grace(Some(used_at), now));
    }

    #[test]
    fn rejects_refresh_retry_after_grace_period() {
        let now = Utc::now();
        let used_at = now - Duration::seconds(REFRESH_RETRY_GRACE_SECONDS + 1);

        assert!(!is_within_retry_grace(Some(used_at), now));
        assert!(!is_within_retry_grace(None, now));
    }
}
