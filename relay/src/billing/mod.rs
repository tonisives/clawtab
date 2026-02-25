use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::error::AppError;

pub struct SubscriptionInfo {
    pub status: String,
    pub current_period_end: Option<DateTime<Utc>>,
}

/// Returns true if the user has an active subscription (or server is self-hosted).
pub async fn is_subscribed(pool: &PgPool, config: &Config, user_id: Uuid) -> Result<bool, AppError> {
    if config.self_hosted {
        return Ok(true);
    }

    let row: Option<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT status, current_period_end FROM subscriptions WHERE user_id = $1"
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    match row {
        Some((status, period_end)) => {
            if status == "active" || status == "trialing" {
                return Ok(true);
            }
            // Grace period: allow access if period hasn't ended yet
            if let Some(end) = period_end {
                if end > Utc::now() {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        None => Ok(false),
    }
}

pub async fn get_subscription(pool: &PgPool, user_id: Uuid) -> Result<Option<SubscriptionInfo>, AppError> {
    let row: Option<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT status, current_period_end FROM subscriptions WHERE user_id = $1"
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(status, end)| SubscriptionInfo {
        status,
        current_period_end: end,
    }))
}
