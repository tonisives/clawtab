pub mod apple;

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
    if config.self_hosted
        || rental_included(pool, user_id).await?
        || apple_access(pool, user_id).await?
    {
        return Ok(true);
    }

    let row: Option<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT status, current_period_end FROM subscriptions s WHERE user_id = $1 AND (s.apple_original_transaction_id IS NULL OR s.stripe_subscription_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM rental_billing_transitions t WHERE t.subscription_id=s.stripe_subscription_id AND t.retired_at IS NOT NULL)"
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
    let row: Option<(String, Option<DateTime<Utc>>, Option<String>)> = sqlx::query_as(
        "SELECT status, period_end, provider FROM ( \
         SELECT CASE WHEN revocation_date IS NOT NULL OR is_upgraded THEN 'revoked' \
                WHEN GREATEST(expires_date,grace_period_expires_date)<=now() THEN 'expired' \
                WHEN auto_renew=false THEN 'canceled' ELSE 'active' END AS status, \
                GREATEST(expires_date,grace_period_expires_date) AS period_end, 'apple' AS provider, \
                revocation_date IS NULL AND NOT is_upgraded AND GREATEST(expires_date,grace_period_expires_date)>now() AS active \
         FROM apple_subscriptions WHERE user_id=$1 \
         UNION ALL SELECT status,current_period_end,CASE WHEN stripe_subscription_id IS NOT NULL THEN 'stripe' END, \
                status IN ('active','trialing') OR current_period_end>now() \
         FROM subscriptions s WHERE user_id=$1 AND (s.apple_original_transaction_id IS NULL OR s.stripe_subscription_id IS NOT NULL) \
         AND NOT EXISTS (SELECT 1 FROM rental_billing_transitions t WHERE t.subscription_id=s.stripe_subscription_id AND t.retired_at IS NOT NULL) \
         ) plans ORDER BY active DESC NULLS LAST, period_end DESC NULLS LAST LIMIT 1"
    ).bind(user_id).fetch_optional(pool).await?;
    Ok(
        row.map(|(status, current_period_end, provider)| SubscriptionInfo {
            status,
            current_period_end,
            provider,
        }),
    )
}

async fn apple_access(pool: &PgPool, user_id: Uuid) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar("SELECT apple_relay_access($1)")
        .bind(user_id)
        .fetch_one(pool)
        .await?)
}

pub async fn rental_included(pool: &PgPool, user_id: Uuid) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar("SELECT rental_relay_access($1)")
        .bind(user_id)
        .fetch_one(pool)
        .await?)
}

pub async fn subscription_providers(pool: &PgPool, user_id: Uuid) -> Result<Vec<String>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT DISTINCT provider FROM (SELECT 'apple' AS provider FROM apple_subscriptions \
         WHERE user_id=$1 AND revocation_date IS NULL AND NOT is_upgraded AND GREATEST(expires_date,grace_period_expires_date)>now() \
         UNION ALL SELECT 'stripe' FROM subscriptions s WHERE user_id=$1 AND stripe_subscription_id IS NOT NULL \
         AND (status IN ('active','trialing') OR current_period_end>now()) \
         AND NOT EXISTS(SELECT 1 FROM rental_billing_transitions t WHERE t.subscription_id=s.stripe_subscription_id AND t.retired_at IS NOT NULL)) plans ORDER BY provider"
    ).bind(user_id).fetch_all(pool).await?)
}
