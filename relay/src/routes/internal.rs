use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use clawtab_protocol::ClientMessage;
use serde::Deserialize;
use uuid::Uuid;

use crate::error::AppError;
use crate::AppState;

/// Body of POST /_internal/dispatch.
/// Commands are delivered to exactly one explicitly selected machine.
#[derive(Deserialize)]
pub struct DispatchBody {
    pub user_id: Uuid,
    pub device_id: Option<Uuid>,
    pub message: ClientMessage,
}

/// Shared-secret middleware: rejects requests without a matching `x-internal-secret` header.
pub async fn internal_secret_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let header = req
        .headers()
        .get("x-internal-secret")
        .and_then(|v| v.to_str().ok());

    let expected = state.config.relay_internal_secret.as_deref();
    match (header, expected) {
        (Some(h), Some(exp)) if h == exp => Ok(next.run(req).await),
        _ => Err(AppError::Unauthorized),
    }
}

pub async fn dispatch(State(state): State<AppState>, Json(body): Json<DispatchBody>) -> Response {
    let device = match body.device_id {
        Some(device) => device,
        None => match crate::machines::legacy_machine(&state, body.user_id).await {
            Ok((_, device)) => device,
            Err(_) => return StatusCode::CONFLICT.into_response(),
        },
    };
    if !matches!(
        crate::machines::access(&state, body.user_id, device).await,
        Ok(None)
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let trigger = match &body.message {
        ClientMessage::RunAgent { trigger_id, .. } | ClientMessage::RunJob { trigger_id, .. } => {
            trigger_id.as_deref()
        }
        _ => None,
    };
    if let Some(trigger) = trigger {
        let Ok(trigger) = Uuid::parse_str(trigger) else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        let updated=sqlx::query("UPDATE trigger_runs SET device_id=$1 WHERE id=$2 AND user_id=$3 AND (device_id IS NULL OR device_id=$1)").bind(device).bind(trigger).bind(body.user_id).execute(&state.pool).await;
        if !updated.is_ok_and(|result| result.rows_affected() == 1) {
            return StatusCode::CONFLICT.into_response();
        }
    }
    let sent = state
        .hub
        .read()
        .await
        .forward_to_device(body.user_id, device, &body.message);

    if sent {
        StatusCode::OK.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}
