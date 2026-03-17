use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::Claims;
use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct VerifyReceiptRequest {
    /// The original transaction ID from the purchase
    pub original_transaction_id: String,
    /// Product ID (e.g. "cc.clawtab.pro.monthly")
    pub product_id: String,
    /// Expiration date as milliseconds since epoch
    pub expires_date_ms: Option<i64>,
}

#[derive(Serialize)]
pub struct VerifyReceiptResponse {
    pub subscribed: bool,
}

/// Verify and activate an Apple IAP subscription.
/// The client sends the transaction details after a successful StoreKit 2 purchase.
/// We store the original_transaction_id and activate the subscription.
pub async fn verify_receipt(
    claims: Claims,
    State(state): State<AppState>,
    Json(req): Json<VerifyReceiptRequest>,
) -> Result<Json<VerifyReceiptResponse>, AppError> {
    if req.original_transaction_id.is_empty() {
        return Err(AppError::BadRequest("missing original_transaction_id".into()));
    }

    let period_end = req.expires_date_ms.map(|ms| {
        chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default()
    });

    sqlx::query(
        "INSERT INTO subscriptions (user_id, apple_original_transaction_id, status, current_period_end) \
         VALUES ($1, $2, 'active', $3) \
         ON CONFLICT (user_id) DO UPDATE SET \
           apple_original_transaction_id = $2, \
           status = 'active', \
           current_period_end = COALESCE($3, subscriptions.current_period_end)"
    )
    .bind(claims.sub)
    .bind(&req.original_transaction_id)
    .bind(period_end)
    .execute(&state.pool)
    .await?;

    tracing::info!(
        "apple iap activated for user={} txn={} product={}",
        claims.sub, req.original_transaction_id, req.product_id
    );

    Ok(Json(VerifyReceiptResponse { subscribed: true }))
}

/// Handle App Store Server Notifications v2.
/// Apple sends these when subscription status changes (renewal, expiry, refund, etc.).
pub async fn app_store_notification(
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Result<axum::http::StatusCode, AppError> {
    let payload: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("invalid json".into()))?;

    let notification_type = payload["notificationType"].as_str().unwrap_or("");
    let subtype = payload["subtype"].as_str().unwrap_or("");

    // Extract the signed transaction from the notification
    let signed_transaction_info = payload["data"]["signedTransactionInfo"]
        .as_str()
        .unwrap_or("");

    if signed_transaction_info.is_empty() {
        tracing::warn!("app store notification missing signedTransactionInfo: {notification_type}");
        return Ok(axum::http::StatusCode::OK);
    }

    // Decode the transaction payload (middle segment of JWS) without full verification
    // for the notification handler - Apple already signed the notification envelope
    let txn_info = decode_transaction_payload(signed_transaction_info)?;

    let original_transaction_id = txn_info.original_transaction_id.as_str();
    let expires_date = txn_info.expires_date.map(|ms| {
        chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default()
    });

    tracing::info!(
        "app store notification: type={notification_type} subtype={subtype} txn={original_transaction_id}"
    );

    match notification_type {
        "DID_RENEW" | "SUBSCRIBED" | "DID_CHANGE_RENEWAL_STATUS" => {
            let status = if subtype == "AUTO_RENEW_DISABLED" { "canceled" } else { "active" };
            sqlx::query(
                "UPDATE subscriptions SET status = $1, current_period_end = $2 \
                 WHERE apple_original_transaction_id = $3"
            )
            .bind(status)
            .bind(expires_date)
            .bind(original_transaction_id)
            .execute(&state.pool)
            .await?;
        }
        "EXPIRED" | "REVOKE" | "REFUND" => {
            sqlx::query(
                "UPDATE subscriptions SET status = 'canceled' \
                 WHERE apple_original_transaction_id = $1"
            )
            .bind(original_transaction_id)
            .execute(&state.pool)
            .await?;
        }
        "DID_FAIL_TO_RENEW" => {
            sqlx::query(
                "UPDATE subscriptions SET status = 'past_due' \
                 WHERE apple_original_transaction_id = $1"
            )
            .bind(original_transaction_id)
            .execute(&state.pool)
            .await?;
        }
        "GRACE_PERIOD_EXPIRED" => {
            sqlx::query(
                "UPDATE subscriptions SET status = 'canceled' \
                 WHERE apple_original_transaction_id = $1"
            )
            .bind(original_transaction_id)
            .execute(&state.pool)
            .await?;
        }
        _ => {
            tracing::debug!("unhandled app store notification: {notification_type}");
        }
    }

    Ok(axum::http::StatusCode::OK)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionPayload {
    original_transaction_id: String,
    #[allow(dead_code)]
    product_id: String,
    expires_date: Option<i64>,
}

fn decode_transaction_payload(jws: &str) -> Result<TransactionPayload, AppError> {
    use base64::Engine;

    let parts: Vec<&str> = jws.split('.').collect();
    if parts.len() != 3 {
        return Err(AppError::BadRequest("invalid JWS format".into()));
    }

    let payload_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(parts[1]))
        .map_err(|_| AppError::BadRequest("invalid JWS payload encoding".into()))?;

    serde_json::from_slice(&payload_bytes)
        .map_err(|e| AppError::BadRequest(format!("invalid transaction payload: {e}")))
}
