use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::Claims;
use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct TestPushRequest {
    pub device_token: String,
}

pub async fn test_push(
    State(state): State<AppState>,
    _claims: Claims,
    Json(req): Json<TestPushRequest>,
) -> Result<Json<Value>, AppError> {
    let Some(ref apns) = state.apns else {
        return Err(AppError::BadRequest("APNs client not configured".into()));
    };

    let options = vec![
        ("1".to_string(), "Test option A".to_string()),
        ("2".to_string(), "Test option B".to_string()),
    ];

    match apns
        .send_question_notification(
            &req.device_token,
            "Test Push",
            "This is a test notification from ClawTab relay",
            "test-question-id",
            "test-pane-id",
            &options,
        )
        .await
    {
        Ok(()) => Ok(Json(json!({
            "ok": true,
            "message": "push sent successfully"
        }))),
        Err(e) => Ok(Json(json!({
            "ok": false,
            "error": e
        }))),
    }
}
