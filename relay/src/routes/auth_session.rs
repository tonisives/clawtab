use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AppState;

#[derive(Deserialize)]
pub struct CreateSessionRequest {
    pub session_id: String,
}

#[derive(Serialize)]
pub struct PollResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<Uuid>,
}

pub async fn create_session(
    State(state): State<AppState>,
    Json(req): Json<CreateSessionRequest>,
) -> StatusCode {
    state.auth_sessions.create(&req.session_id).await;
    StatusCode::CREATED
}

pub async fn poll_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<PollResponse>) {
    match state.auth_sessions.poll(&id).await {
        Some(Some(result)) => {
            state.auth_sessions.remove(&id).await;
            (
                StatusCode::OK,
                Json(PollResponse {
                    status: "complete".into(),
                    access_token: Some(result.access_token),
                    refresh_token: Some(result.refresh_token),
                    user_id: Some(result.user_id),
                }),
            )
        }
        Some(None) => (
            StatusCode::OK,
            Json(PollResponse {
                status: "pending".into(),
                access_token: None,
                refresh_token: None,
                user_id: None,
            }),
        ),
        None => (
            StatusCode::NOT_FOUND,
            Json(PollResponse {
                status: "not_found".into(),
                access_token: None,
                refresh_token: None,
                user_id: None,
            }),
        ),
    }
}
