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
    /// For "Type something" answers: the option number that opens freetext input.
    /// When set, `answer` is the keystroke and `freetext` is the typed text.
    freetext: Option<String>,
}

pub async fn answer(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<AnswerRequest>,
) -> Result<Json<Value>, AppError> {
    let (machine, pane) = match req.pane_id.split_once("::") {
        Some((machine, pane)) => (
            uuid::Uuid::parse_str(machine)
                .map_err(|_| AppError::BadRequest("invalid machine".into()))?,
            pane.to_owned(),
        ),
        None => {
            let (_, machine) = crate::machines::legacy_machine(&state, claims.sub).await?;
            (machine, req.pane_id.clone())
        }
    };
    if req
        .question_id
        .split_once("::")
        .is_some_and(|(id, _)| uuid::Uuid::parse_str(id).ok() != Some(machine))
    {
        return Err(AppError::BadRequest(
            "question belongs to another machine".into(),
        ));
    }
    let grant = crate::machines::access(&state, claims.sub, machine).await?;
    let question = req
        .question_id
        .split_once("::")
        .map(|(_, q)| q)
        .unwrap_or(&req.question_id)
        .to_owned();
    let msg = ClientMessage::AnswerQuestion {
        id: format!("http_{}", uuid::Uuid::new_v4()),
        question_id: question.clone(),
        pane_id: pane.clone(),
        answer: req.answer.clone(),
        freetext: req.freetext.clone(),
    };
    {
        let mut hub = state.machines.write().await;
        let key = (machine, pane.clone(), question.clone());
        if hub.answered.contains(&key) {
            return Err(AppError::Conflict("question already resolved".into()));
        }
        let questions = hub
            .snapshots
            .get(&(machine, "claude_questions".into()))
            .and_then(|v| v["questions"].as_array())
            .ok_or_else(|| AppError::Conflict("question is no longer active".into()))?;
        let visible = questions.iter().any(|q| {
            q["pane_id"] == pane
                && q["question_id"] == question
                && grant
                    .as_ref()
                    .and_then(|g| g.as_deref())
                    .is_none_or(|groups| {
                        q["matched_group"]
                            .as_str()
                            .is_some_and(|group| groups.iter().any(|g| g == group))
                    })
        });
        if !visible {
            return Err(AppError::Forbidden);
        }
        let host = hub
            .hosts
            .get(&machine)
            .ok_or_else(|| AppError::Conflict("machine is offline".into()))?;
        let text = serde_json::to_string(&msg)
            .map_err(|_| AppError::BadRequest("invalid answer".into()))?;
        host.tx
            .try_send(text)
            .map_err(|_| AppError::Conflict("machine is busy or disconnected".into()))?;
        hub.answered.insert(key);
    }
    let sent = true;
    // Mark answered in DB (fire and forget)
    let pool = state.pool.clone();
    let qid = req.question_id;
    let ans = req.answer;
    tokio::spawn(async move {
        sqlx::query(
            "UPDATE notification_history SET answered = true, answered_with = $1 WHERE question_id = $2 AND user_id = $3",
        )
        .bind(&ans)
        .bind(&qid)
        .bind(claims.sub)
        .execute(&pool)
        .await
        .ok();
    });

    Ok(Json(json!({ "sent": sent })))
}
