use axum::extract::State;
use axum::Json;
use clawtab_protocol::ClientMessage;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::Claims;
use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct AnswerRequest {
    question_id: String,
    pane_id: String,
    answer: String,
}

pub async fn answer(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<AnswerRequest>,
) -> Result<Json<Value>, AppError> {
    let msg = ClientMessage::AnswerQuestion {
        id: format!("http_{}", req.question_id),
        question_id: req.question_id.clone(),
        pane_id: req.pane_id,
        answer: req.answer.clone(),
    };

    // Forward to desktop
    let sent = {
        let hub = state.hub.read().await;
        hub.forward_to_desktop(claims.sub, &msg)
    };

    // Mark answered in DB (fire and forget)
    let pool = state.pool.clone();
    let qid = req.question_id;
    let ans = req.answer;
    tokio::spawn(async move {
        sqlx::query(
            "UPDATE notification_history SET answered = true, answered_with = $1 WHERE question_id = $2",
        )
        .bind(&ans)
        .bind(&qid)
        .execute(&pool)
        .await
        .ok();
    });

    Ok(Json(json!({ "sent": sent })))
}
