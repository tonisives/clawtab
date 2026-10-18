use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{auth::Claims, billing::apple, error::AppError, AppState};

const BUNDLE_ID: &str = "cc.clawtab";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyReceiptRequest {
    pub signed_transaction: String,
}

#[derive(Serialize)]
pub struct VerifyReceiptResponse {
    pub subscribed: bool,
}

pub async fn verify_receipt(
    claims: Claims,
    State(state): State<AppState>,
    Json(req): Json<VerifyReceiptRequest>,
) -> Result<Json<VerifyReceiptResponse>, AppError> {
    let transaction = apple::verify_transaction(&req.signed_transaction, BUNDLE_ID)
        .map_err(|_| AppError::BadRequest("Apple purchase could not be verified".into()))?;
    Ok(Json(VerifyReceiptResponse {
        subscribed: activate_transaction(&state.pool, claims.sub, &transaction).await?,
    }))
}

async fn activate_transaction(
    pool: &PgPool,
    user: Uuid,
    transaction: &apple::VerifiedTransaction,
) -> Result<bool, AppError> {
    if !transaction.belongs_to(user) {
        return Err(account_conflict());
    }
    let mut tx = pool.begin().await?;
    let owner = transaction_owner(&mut tx, transaction).await?;
    if owner.is_some_and(|id| id != user) {
        return Err(account_conflict());
    }
    persist_transaction(&mut tx, user, transaction).await?;
    tx.commit().await?;
    apple_access(pool, user).await
}

fn account_conflict() -> AppError {
    AppError::Conflict("This Apple subscription belongs to another ClawTab account".into())
}

// Serialize first claims and notification updates, including before a row exists.
async fn transaction_owner(
    tx: &mut Transaction<'_, Postgres>,
    transaction: &apple::VerifiedTransaction,
) -> Result<Option<Uuid>, AppError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "apple:{}:{}",
            transaction.environment, transaction.original_transaction_id
        ))
        .execute(&mut **tx)
        .await?;
    let owner: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM apple_subscriptions WHERE environment=$1 AND original_transaction_id=$2"
    ).bind(transaction.environment).bind(&transaction.original_transaction_id)
        .fetch_optional(&mut **tx).await?;
    if owner.is_some() {
        return Ok(owner);
    }
    // Keep ownership of purchases linked by older app versions, but never trust
    // those versions' client-supplied expiry or status for access.
    Ok(sqlx::query_scalar(
        "SELECT user_id FROM subscriptions WHERE apple_original_transaction_id=$1",
    )
    .bind(&transaction.original_transaction_id)
    .fetch_optional(&mut **tx)
    .await?)
}

async fn persist_transaction(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    transaction: &apple::VerifiedTransaction,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO apple_subscriptions AS existing \
         (environment,original_transaction_id,user_id,transaction_id,product_id,purchase_date,expires_date,signed_date,revocation_date,is_upgraded) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) \
         ON CONFLICT (environment,original_transaction_id) DO UPDATE SET \
         transaction_id=EXCLUDED.transaction_id, product_id=EXCLUDED.product_id, \
         purchase_date=EXCLUDED.purchase_date, expires_date=EXCLUDED.expires_date, \
         signed_date=EXCLUDED.signed_date, revocation_date=EXCLUDED.revocation_date, is_upgraded=EXCLUDED.is_upgraded \
         WHERE existing.user_id=EXCLUDED.user_id AND \
         (EXCLUDED.purchase_date > existing.purchase_date OR \
          (EXCLUDED.purchase_date=existing.purchase_date AND EXCLUDED.signed_date > existing.signed_date))"
    ).bind(transaction.environment).bind(&transaction.original_transaction_id).bind(user)
        .bind(&transaction.transaction_id).bind(&transaction.product_id)
        .bind(transaction.purchase_date).bind(transaction.expires_date).bind(transaction.signed_date)
        .bind(transaction.revocation_date).bind(transaction.is_upgraded)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn apple_access(pool: &PgPool, user: Uuid) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar("SELECT apple_relay_access($1)")
        .bind(user)
        .fetch_one(pool)
        .await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRequest {
    signed_payload: String,
}

pub async fn app_store_notification(
    State(state): State<AppState>,
    Json(req): Json<NotificationRequest>,
) -> Result<StatusCode, AppError> {
    let notification = apple::verify_notification(&req.signed_payload, BUNDLE_ID)
        .map_err(|_| AppError::BadRequest("Apple notification could not be verified".into()))?;
    apply_notification(&state.pool, notification).await?;
    Ok(StatusCode::OK)
}

async fn apply_notification(
    pool: &PgPool,
    notification: apple::VerifiedNotification,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    let inserted = sqlx::query("INSERT INTO apple_notifications(environment,notification_id) VALUES ($1,$2) ON CONFLICT DO NOTHING")
        .bind(notification.environment).bind(&notification.id).execute(&mut *tx).await?;
    if inserted.rows_affected() == 0 {
        return Ok(());
    }
    if let Some(mut transaction) = notification.transaction {
        let owner = transaction_owner(&mut tx, &transaction).await?;
        let user = owner.or(transaction.app_account_token);
        if let Some(user) = user {
            if !transaction.belongs_to(user) {
                return Err(account_conflict());
            }
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)")
                .bind(user)
                .fetch_one(&mut *tx)
                .await?;
            if exists {
                // A refund/revocation applies immediately. Cancellation of renewal
                // only changes auto_renew; paid access lasts through its expiry.
                if matches!(notification.notification_type.as_str(), "REFUND" | "REVOKE") {
                    transaction.revocation_date = transaction
                        .revocation_date
                        .or(Some(notification.signed_date));
                    transaction.signed_date = transaction.signed_date.max(notification.signed_date);
                }
                persist_transaction(&mut tx, user, &transaction).await?;
                if let Some(signed_date) = notification.renewal_signed_date {
                    sqlx::query("UPDATE apple_subscriptions SET auto_renew=$1, renewal_signed_date=$2, grace_period_expires_date=$3 \
                        WHERE environment=$4 AND original_transaction_id=$5 AND \
                        (renewal_signed_date IS NULL OR renewal_signed_date < $2)")
                        .bind(notification.auto_renew).bind(signed_date).bind(notification.grace_period_expires_date)
                        .bind(transaction.environment).bind(&transaction.original_transaction_id)
                        .execute(&mut *tx).await?;
                }
            }
        }
    }
    tx.commit().await?;
    tracing::info!(stage="apple-notification-applied", kind=%notification.notification_type);
    Ok(())
}

#[cfg(test)]
mod tests;
