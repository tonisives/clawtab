use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::Claims;
use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct HistoryQuery {
    limit: Option<i64>,
}

pub async fn history(
    State(state): State<AppState>,
    claims: Claims,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = query.limit.unwrap_or(20).min(50);

    let rows: Vec<(String, String, String, String, serde_json::Value, bool, Option<String>, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT question_id, pane_id, cwd, context_lines, options, answered, answered_with, created_at
         FROM notification_history
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2",
    )
    .bind(claims.sub)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let notifications: Vec<Value> = rows
        .into_iter()
        .map(|(question_id, pane_id, cwd, context_lines, options, answered, answered_with, created_at)| {
            json!({
                "question_id": question_id,
                "pane_id": pane_id,
                "cwd": cwd,
                "context_lines": context_lines,
                "options": options,
                "answered": answered,
                "answered_with": answered_with,
                "created_at": created_at.to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!({ "notifications": notifications })))
}
