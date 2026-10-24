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
    pub hosted_workspace_eligible: bool,
    pub relay_included: bool,
    pub status: Option<String>,
    pub current_period_end: Option<String>,
    pub provider: Option<String>,
    pub providers: Vec<String>,
}

pub async fn status(
    claims: Claims,
    State(state): State<AppState>,
) -> Result<Json<SubscriptionStatus>, AppError> {
    let subscribed = billing::is_subscribed(&state.pool, &state.config, claims.sub).await?;
    let sub = billing::get_subscription(&state.pool, claims.sub).await?;

    Ok(Json(SubscriptionStatus {
        subscribed,
        hosted_workspace_eligible: sqlx::query_scalar("SELECT hosted_relay_access($1)")
            .bind(claims.sub)
            .fetch_one(&state.pool)
            .await?,
        providers: billing::subscription_providers(&state.pool, claims.sub).await?,
        relay_included: billing::rental_included(&state.pool, claims.sub).await?,
        status: sub.as_ref().map(|s| s.status.clone()),
        current_period_end: sub
            .as_ref()
            .and_then(|s| s.current_period_end.map(|e| e.to_rfc3339())),
        provider: sub.as_ref().and_then(|s| s.provider.clone()),
    }))
}
