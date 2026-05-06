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
/// `device_id` is currently advisory: the relay forwards to all of the user's
/// online desktops. v2 may target a specific device.
#[derive(Deserialize)]
pub struct DispatchBody {
    pub user_id: Uuid,
    #[allow(dead_code)]
    pub device_id: Option<Uuid>,
    pub message: ClientMessage,
}

/// Shared-secret middleware: rejects requests without a matching `x-internal-secret` header.
pub async fn internal_secret_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let header = req.headers()
        .get("x-internal-secret")
        .and_then(|v| v.to_str().ok());

    let expected = state.config.relay_internal_secret.as_deref();
    match (header, expected) {
        (Some(h), Some(exp)) if h == exp => Ok(next.run(req).await),
        _ => Err(AppError::Unauthorized),
    }
}

pub async fn dispatch(
    State(state): State<AppState>,
    Json(body): Json<DispatchBody>,
) -> Response {
    let hub = state.hub.read().await;
    let sent = hub.forward_to_desktop(body.user_id, &body.message);
    drop(hub);

    if sent {
        StatusCode::OK.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}
