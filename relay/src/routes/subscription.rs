use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::auth::Claims;
use crate::billing;
use crate::error::AppError;
use crate::AppState;

#[derive(Serialize)]
pub struct SubscriptionStatus {
    pub subscribed: bool,
    pub status: Option<String>,
    pub current_period_end: Option<String>,
}

pub async fn status(
    claims: Claims,
    State(state): State<AppState>,
) -> Result<Json<SubscriptionStatus>, AppError> {
    let subscribed = billing::is_subscribed(&state.pool, &state.config, claims.sub).await?;
    let sub = billing::get_subscription(&state.pool, claims.sub).await?;

    Ok(Json(SubscriptionStatus {
        subscribed,
        status: sub.as_ref().map(|s| s.status.clone()),
        current_period_end: sub
            .as_ref()
            .and_then(|s| s.current_period_end.map(|e| e.to_rfc3339())),
    }))
}
