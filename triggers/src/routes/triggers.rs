use std::collections::HashMap;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Utc};
use clawtab_protocol::ClientMessage;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::ApiTokenUser;
use crate::dispatch::DispatchOutcome;
use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct AgentRequest {
    pub prompt: String,
    pub work_dir: Option<String>,
}

#[derive(Deserialize)]
pub struct RunRequest {
    pub device_id: Option<Uuid>,
    pub job: Option<String>,
    pub agent: Option<AgentRequest>,
    #[serde(default)]
    pub params: HashMap<String, String>,
    #[serde(default)]
    pub wait: bool,
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct TriggerView {
    pub id: Uuid,
    pub status: String,
    pub kind: String,
    pub job_name: Option<String>,
    pub exit_code: Option<i32>,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub dispatched_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub poll_url: String,
}

type TriggerRow = (
    Uuid,                         // id
    String,                       // status
    String,                       // kind
    Option<String>,               // job_name
    Option<i32>,                  // exit_code
    Option<serde_json::Value>,    // result
    Option<String>,               // error
    DateTime<Utc>,                // created_at
    Option<DateTime<Utc>>,        // dispatched_at
    Option<DateTime<Utc>>,        // finished_at
);

fn row_to_view(r: TriggerRow) -> TriggerView {
    TriggerView {
        id: r.0,
        poll_url: format!("/v1/triggers/{}", r.0),
        status: r.1,
        kind: r.2,
        job_name: r.3,
        exit_code: r.4,
        result: r.5,
        error: r.6,
        created_at: r.7,
        dispatched_at: r.8,
        finished_at: r.9,
    }
}

async fn fetch_row(state: &AppState, id: Uuid, user_id: Uuid) -> Result<TriggerRow, AppError> {
    let row: Option<TriggerRow> = sqlx::query_as(
        "SELECT id, status, kind, job_name, exit_code, result, error,
                created_at, dispatched_at, finished_at
         FROM trigger_runs WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    row.ok_or_else(|| AppError::NotFound("trigger not found".into()))
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "no_device")
}

pub async fn run(
    State(state): State<AppState>,
    user: ApiTokenUser,
    Json(body): Json<RunRequest>,
) -> Result<axum::response::Response, AppError> {
    let (kind, job_name, agent_prompt, work_dir) = match (&body.job, &body.agent) {
        (Some(name), None) => ("job".to_string(), Some(name.clone()), None, None),
        (None, Some(agent)) => (
            "agent".to_string(),
            None,
            Some(agent.prompt.clone()),
            agent.work_dir.clone(),
        ),
        (Some(_), Some(_)) => {
            return Err(AppError::BadRequest("provide exactly one of `job` or `agent`".into()));
        }
        (None, None) => {
            return Err(AppError::BadRequest("missing `job` or `agent`".into()));
        }
    };

    let params_json = serde_json::to_value(&body.params).unwrap_or(serde_json::Value::Null);

    let trigger_id: Uuid = sqlx::query_scalar(
        "INSERT INTO trigger_runs (user_id, device_id, kind, job_name, agent_prompt, work_dir, params, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued') RETURNING id",
    )
    .bind(user.user_id)
    .bind(body.device_id)
    .bind(&kind)
    .bind(&job_name)
    .bind(&agent_prompt)
    .bind(&work_dir)
    .bind(&params_json)
    .fetch_one(&state.pool)
    .await?;

    // Subscribe before dispatching to avoid a wakeup race.
    let notify = state.waiters.subscribe(trigger_id).await;

    let message = match kind.as_str() {
        "job" => ClientMessage::RunJob {
            id: trigger_id.to_string(),
            name: job_name.clone().unwrap_or_default(),
            params: body.params.clone(),
            trigger_id: Some(trigger_id.to_string()),
        },
        _ => ClientMessage::RunAgent {
            id: trigger_id.to_string(),
            prompt: agent_prompt.clone().unwrap_or_default(),
            work_dir: work_dir.clone(),
            provider: None,
            model: None,
            trigger_id: Some(trigger_id.to_string()),
        },
    };

    let outcome = state.dispatcher.dispatch(user.user_id, body.device_id, &message).await?;

    match outcome {
        DispatchOutcome::Sent => {
            sqlx::query("UPDATE trigger_runs SET status = 'dispatched', dispatched_at = now() WHERE id = $1")
                .bind(trigger_id)
                .execute(&state.pool)
                .await?;
        }
        DispatchOutcome::NoDevice => {
            sqlx::query("UPDATE trigger_runs SET status = 'no_device', finished_at = now() WHERE id = $1")
                .bind(trigger_id)
                .execute(&state.pool)
                .await?;
            state.waiters.release(trigger_id).await;
            let row = fetch_row(&state, trigger_id, user.user_id).await?;
            return Ok((StatusCode::CONFLICT, Json(row_to_view(row))).into_response());
        }
    }

    if !body.wait {
        let row = fetch_row(&state, trigger_id, user.user_id).await?;
        state.waiters.release(trigger_id).await;
        return Ok((StatusCode::ACCEPTED, Json(row_to_view(row))).into_response());
    }

    let max = state.config.max_sync_wait_ms;
    let timeout_ms = body.timeout_ms.unwrap_or(max).min(max);

    let waited = wait_terminal(&state, trigger_id, user.user_id, &notify, timeout_ms).await?;
    state.waiters.release(trigger_id).await;

    if waited.is_none() {
        // Timeout: report current row but mark status as "timeout" view-only;
        // do NOT mutate db status, the run is still in flight.
        let mut row = fetch_row(&state, trigger_id, user.user_id).await?;
        row.1 = "timeout".to_string();
        return Ok((StatusCode::OK, Json(row_to_view(row))).into_response());
    }

    let row = fetch_row(&state, trigger_id, user.user_id).await?;
    Ok((StatusCode::OK, Json(row_to_view(row))).into_response())
}

pub async fn get_one(
    State(state): State<AppState>,
    user: ApiTokenUser,
    Path(id): Path<Uuid>,
) -> Result<Json<TriggerView>, AppError> {
    let row = fetch_row(&state, id, user.user_id).await?;
    Ok(Json(row_to_view(row)))
}

#[derive(Deserialize)]
pub struct WaitParams {
    pub timeout_ms: Option<u64>,
}

pub async fn wait_for(
    State(state): State<AppState>,
    user: ApiTokenUser,
    Path(id): Path<Uuid>,
    Query(params): Query<WaitParams>,
) -> Result<Json<TriggerView>, AppError> {
    let row = fetch_row(&state, id, user.user_id).await?;
    if is_terminal(&row.1) {
        return Ok(Json(row_to_view(row)));
    }

    let notify = state.waiters.subscribe(id).await;
    let max = state.config.max_sync_wait_ms;
    let timeout_ms = params.timeout_ms.unwrap_or(max).min(max);
    let waited = wait_terminal(&state, id, user.user_id, &notify, timeout_ms).await?;
    state.waiters.release(id).await;

    if waited.is_none() {
        let mut row = fetch_row(&state, id, user.user_id).await?;
        row.1 = "timeout".to_string();
        return Ok(Json(row_to_view(row)));
    }

    let row = fetch_row(&state, id, user.user_id).await?;
    Ok(Json(row_to_view(row)))
}

async fn wait_terminal(
    state: &AppState,
    id: Uuid,
    user_id: Uuid,
    notify: &tokio::sync::Notify,
    timeout_ms: u64,
) -> Result<Option<()>, AppError> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let row = fetch_row(state, id, user_id).await?;
        if is_terminal(&row.1) {
            return Ok(Some(()));
        }

        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }

        let notified = notify.notified();
        tokio::pin!(notified);
        match tokio::time::timeout(remaining, &mut notified).await {
            Ok(()) => continue,
            Err(_) => return Ok(None),
        }
    }
}
