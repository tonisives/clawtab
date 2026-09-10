use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::error::AppError;

pub struct SubscriptionInfo {
    pub status: String,
    pub current_period_end: Option<DateTime<Utc>>,
    pub provider: Option<String>,
}

/// Returns true if the user has an active subscription (or server is self-hosted).
pub async fn is_subscribed(
    pool: &PgPool,
    config: &Config,
    user_id: Uuid,
) -> Result<bool, AppError> {
    if config.self_hosted || rental_included(pool, user_id).await? {
        return Ok(true);
    }

    let row: Option<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT status, current_period_end FROM subscriptions s WHERE user_id = $1 AND (s.apple_original_transaction_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM rental_billing_transitions t WHERE t.subscription_id=s.stripe_subscription_id AND t.retired_at IS NOT NULL))"
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

pub async fn get_subscription(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Option<SubscriptionInfo>, AppError> {
    let row: Option<(
        String,
        Option<DateTime<Utc>>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT status, current_period_end, stripe_subscription_id, apple_original_transaction_id \
         FROM subscriptions WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(status, end, stripe_id, apple_id)| {
        let provider = if apple_id.is_some() {
            Some("apple".to_string())
        } else if stripe_id.is_some() {
            Some("stripe".to_string())
        } else {
            None
        };
        SubscriptionInfo {
            status,
            current_period_end: end,
            provider,
        }
    }))
}

pub async fn rental_included(pool: &PgPool, user_id: Uuid) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar("SELECT rental_relay_access($1)")
        .bind(user_id)
        .fetch_one(pool)
        .await?)
}
