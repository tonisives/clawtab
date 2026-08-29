use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Utc};
use clawtab_protocol::{ClientMessage, JobPolicy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::ApiTokenUser;
use crate::dispatch::DispatchOutcome;
use crate::error::AppError;
use crate::AppState;

const NO_DEVICE_RETRY_SECONDS: i64 = 60;

#[derive(Clone, Deserialize)]
pub struct AgentRequest {
    pub prompt: String,
    pub work_dir: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub policy: Option<PolicyInput>,
}

/// The public policy shape is deliberately narrow. A string is convenient for
/// callers, while the object form makes the named local resource explicit.
#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum PolicyInput {
    Name(String),
    Named(NamedPolicyInput),
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamedPolicyInput {
    pub name: String,
    #[serde(default)]
    pub resource_key: Option<String>,
}

#[derive(Deserialize)]
pub struct RunRequest {
    pub device_id: Option<Uuid>,
    pub job: Option<String>,
    pub agent: Option<AgentRequest>,
    #[serde(default)]
    pub params: HashMap<String, String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub policy: Option<PolicyInput>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
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
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub policy: Option<String>,
    pub idempotency_key: Option<String>,
    pub exit_code: Option<i32>,
    pub result: Option<serde_json::Value>,
    /// `valid`, `missing`, `invalid_json`, `unreadable`, or `not_requested`.
    pub result_status: Option<String>,
    pub error: Option<String>,
    pub retry_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub dispatched_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub poll_url: String,
}

#[derive(sqlx::FromRow)]
struct TriggerRow {
    id: Uuid,
    status: String,
    kind: String,
    job_name: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    policy: Option<String>,
    idempotency_key: Option<String>,
    exit_code: Option<i32>,
    result: Option<serde_json::Value>,
    result_status: Option<String>,
    error: Option<String>,
    retry_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    dispatched_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
}

fn row_to_view(r: TriggerRow) -> TriggerView {
    TriggerView {
        id: r.id,
        poll_url: format!("/v1/triggers/{}", r.id),
        status: r.status,
        kind: r.kind,
        job_name: r.job_name,
        provider: r.provider,
        model: r.model,
        effort: r.effort,
        policy: r.policy,
        idempotency_key: r.idempotency_key,
        exit_code: r.exit_code,
        result: r.result,
        result_status: r.result_status,
        error: r.error,
        retry_at: r.retry_at,
        created_at: r.created_at,
        dispatched_at: r.dispatched_at,
        finished_at: r.finished_at,
    }
}

async fn fetch_row(state: &AppState, id: Uuid, user_id: Uuid) -> Result<TriggerRow, AppError> {
    let row: Option<TriggerRow> = sqlx::query_as(
        "SELECT id, status, kind, job_name, provider, model, effort, policy,
                idempotency_key, exit_code, result, result_status, error, retry_at,
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
    matches!(
        status,
        "succeeded" | "failed" | "no_device" | "deferred" | "rejected"
    )
}

#[derive(Clone, Debug)]
struct NormalizedRequest {
    kind: String,
    job_name: Option<String>,
    agent_prompt: Option<String>,
    work_dir: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    policy: Option<JobPolicy>,
}

fn merge_string(
    field: &str,
    outer: Option<String>,
    nested: Option<String>,
) -> Result<Option<String>, AppError> {
    match (outer, nested) {
        (Some(a), Some(b)) if a != b => {
            Err(AppError::BadRequest(format!("conflicting {field} values")))
        }
        (Some(value), _) | (None, Some(value)) => Ok(Some(value)),
        (None, None) => Ok(None),
    }
}

fn parse_policy(input: Option<&PolicyInput>) -> Result<Option<JobPolicy>, AppError> {
    let Some(input) = input else {
        return Ok(None);
    };
    let (name, resource_key) = match input {
        PolicyInput::Name(name) => (name.as_str(), None),
        PolicyInput::Named(policy) => (policy.name.as_str(), policy.resource_key.as_deref()),
    };
    let normalized_name = name.trim().replace('-', "_");
    if normalized_name != "crm_social_research" {
        return Err(AppError::BadRequest(format!("unsupported policy `{name}`")));
    }
    if let Some(resource_key) = resource_key {
        if resource_key != JobPolicy::CrmSocialResearch.resource_key() {
            return Err(AppError::BadRequest(format!(
                "policy `crm_social_research` requires resource key `{}`",
                JobPolicy::CrmSocialResearch.resource_key()
            )));
        }
    }
    Ok(Some(JobPolicy::CrmSocialResearch))
}

fn normalize_request(body: &RunRequest) -> Result<NormalizedRequest, AppError> {
    let (kind, job_name, agent_prompt, work_dir, nested) = match (&body.job, &body.agent) {
        (Some(name), None) => ("job".to_string(), Some(name.clone()), None, None, None),
        (None, Some(agent)) => (
            "agent".to_string(),
            None,
            Some(agent.prompt.clone()),
            agent.work_dir.clone(),
            Some(agent),
        ),
        (Some(_), Some(_)) => {
            return Err(AppError::BadRequest(
                "provide exactly one of `job` or `agent`".into(),
            ));
        }
        (None, None) => {
            return Err(AppError::BadRequest("missing `job` or `agent`".into()));
        }
    };

    let provider = merge_string(
        "provider",
        body.provider.clone(),
        nested.and_then(|agent| agent.provider.clone()),
    )?;
    let model = merge_string(
        "model",
        body.model.clone(),
        nested.and_then(|agent| agent.model.clone()),
    )?;
    let effort = merge_string(
        "effort",
        body.effort.clone(),
        nested.and_then(|agent| agent.effort.clone()),
    )?;

    let outer_policy = parse_policy(body.policy.as_ref())?;
    let nested_policy = parse_policy(nested.and_then(|agent| agent.policy.as_ref()))?;
    let policy = match (outer_policy, nested_policy) {
        (Some(a), Some(b)) if a != b => {
            return Err(AppError::BadRequest("conflicting policy values".into()));
        }
        (Some(policy), _) | (None, Some(policy)) => Some(policy),
        (None, None) => None,
    };

    let options = validate_model_options(provider, model, effort, policy)?;

    Ok(NormalizedRequest {
        kind,
        job_name,
        agent_prompt,
        work_dir,
        provider: options.provider,
        model: options.model,
        effort: options.effort,
        policy,
    })
}

#[derive(Debug)]
struct ModelOptions {
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

fn validate_model_options(
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    policy: Option<JobPolicy>,
) -> Result<ModelOptions, AppError> {
    if let Some(provider) = provider.as_deref() {
        if provider != "codex" {
            return Err(AppError::BadRequest(
                "provider must be `codex` for remote trigger requests".into(),
            ));
        }
    }
    if let Some(model) = model.as_deref() {
        if model != "gpt-5.6-luna" {
            return Err(AppError::BadRequest(
                "model must be `gpt-5.6-luna` for remote trigger requests".into(),
            ));
        }
    }
    if let Some(effort) = effort.as_deref() {
        if !matches!(effort, "medium" | "max") {
            return Err(AppError::BadRequest(
                "effort must be `medium` or `max` for remote trigger requests".into(),
            ));
        }
    }

    if policy == Some(JobPolicy::CrmSocialResearch) {
        Ok(ModelOptions {
            provider: Some(provider.unwrap_or_else(|| "codex".into())),
            model: Some(model.unwrap_or_else(|| "gpt-5.6-luna".into())),
            effort: Some(effort.unwrap_or_else(|| "medium".into())),
        })
    } else {
        Ok(ModelOptions {
            provider,
            model,
            effort,
        })
    }
}

#[derive(Serialize)]
struct RequestFingerprint {
    kind: String,
    job_name: Option<String>,
    agent_prompt: Option<String>,
    work_dir: Option<String>,
    device_id: Option<Uuid>,
    params: BTreeMap<String, String>,
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    policy: Option<String>,
}

fn request_hash(
    request: &NormalizedRequest,
    device_id: Option<Uuid>,
    params: &HashMap<String, String>,
) -> String {
    let fingerprint = RequestFingerprint {
        kind: request.kind.clone(),
        job_name: request.job_name.clone(),
        agent_prompt: request.agent_prompt.clone(),
        work_dir: request.work_dir.clone(),
        device_id,
        params: params.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        provider: request.provider.clone(),
        model: request.model.clone(),
        effort: request.effort.clone(),
        policy: request.policy.map(|policy| policy.as_str().into()),
    };
    let bytes = serde_json::to_vec(&fingerprint).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn idempotency_key(headers: &HeaderMap, body: &RunRequest) -> Result<Option<String>, AppError> {
    let header = headers
        .get("idempotency-key")
        .map(|value| {
            value
                .to_str()
                .map(str::to_owned)
                .map_err(|_| AppError::BadRequest("idempotency key must be valid ASCII".into()))
        })
        .transpose()?;
    let body_key = body.idempotency_key.clone();
    if header.is_some() && body_key.is_some() && header != body_key {
        return Err(AppError::BadRequest(
            "header and body idempotency keys must match".into(),
        ));
    }
    let key = header.or(body_key);
    if let Some(key) = &key {
        if key.is_empty() || key.len() > 255 || key.chars().any(char::is_control) {
            return Err(AppError::BadRequest(
                "idempotency key must contain 1-255 non-control characters".into(),
            ));
        }
    }
    Ok(key)
}

fn validate_idempotent_replay(
    existing_hash: Option<&str>,
    request_hash: &str,
) -> Result<(), AppError> {
    if existing_hash == Some(request_hash) {
        Ok(())
    } else {
        Err(AppError::Conflict(
            "idempotency key is already used for a different request".into(),
        ))
    }
}

pub async fn run(
    State(state): State<AppState>,
    user: ApiTokenUser,
    headers: HeaderMap,
    Json(body): Json<RunRequest>,
) -> Result<axum::response::Response, AppError> {
    let request = normalize_request(&body)?;
    let key = idempotency_key(&headers, &body)?;
    let request_hash = request_hash(&request, body.device_id, &body.params);
    let params_json = serde_json::to_value(&body.params).unwrap_or(serde_json::Value::Null);
    let policy_name = request.policy.map(|policy| policy.as_str().to_string());

    let inserted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO trigger_runs
            (user_id, device_id, kind, job_name, agent_prompt, work_dir, params,
             status, idempotency_key, request_hash, provider, model, effort, policy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10, $11, $12, $13)
         ON CONFLICT DO NOTHING
         RETURNING id",
    )
    .bind(user.user_id)
    .bind(body.device_id)
    .bind(&request.kind)
    .bind(&request.job_name)
    .bind(&request.agent_prompt)
    .bind(&request.work_dir)
    .bind(&params_json)
    .bind(&key)
    .bind(&request_hash)
    .bind(&request.provider)
    .bind(&request.model)
    .bind(&request.effort)
    .bind(&policy_name)
    .fetch_optional(&state.pool)
    .await?;

    let (trigger_id, is_new) = match inserted {
        Some(id) => (id, true),
        None => {
            let Some(key) = key.as_deref() else {
                return Err(AppError::Internal(
                    "trigger insert conflicted without an idempotency key".into(),
                ));
            };
            let existing: Option<(Uuid, Option<String>)> = sqlx::query_as(
                "SELECT id, request_hash FROM trigger_runs
                 WHERE user_id = $1 AND idempotency_key = $2",
            )
            .bind(user.user_id)
            .bind(key)
            .fetch_optional(&state.pool)
            .await?;
            let Some((id, existing_hash)) = existing else {
                return Err(AppError::Internal(
                    "idempotent trigger row disappeared after insert conflict".into(),
                ));
            };
            validate_idempotent_replay(existing_hash.as_deref(), &request_hash)?;
            (id, false)
        }
    };

    if !is_new {
        return respond_existing(&state, user.user_id, trigger_id, &body).await;
    }

    let notify = if body.wait {
        Some(state.waiters.subscribe(trigger_id).await)
    } else {
        None
    };

    let message = match request.kind.as_str() {
        "job" => ClientMessage::RunJob {
            id: trigger_id.to_string(),
            name: request.job_name.clone().unwrap_or_default(),
            params: body.params.clone(),
            provider: request.provider.clone(),
            model: request.model.clone(),
            effort: request.effort.clone(),
            policy: request.policy,
            trigger_id: Some(trigger_id.to_string()),
        },
        _ => ClientMessage::RunAgent {
            id: trigger_id.to_string(),
            prompt: request.agent_prompt.clone().unwrap_or_default(),
            work_dir: request.work_dir.clone(),
            provider: request.provider.clone(),
            model: request.model.clone(),
            effort: request.effort.clone(),
            policy: request.policy,
            trigger_id: Some(trigger_id.to_string()),
        },
    };

    let outcome = match state
        .dispatcher
        .dispatch(user.user_id, body.device_id, &message)
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = mark_trigger(
                &state,
                trigger_id,
                TriggerUpdate {
                    status: "failed",
                    exit_code: None,
                    result: None,
                    result_status: Some("not_requested"),
                    error: Some(error.to_string()),
                    retry_at: None,
                },
            )
            .await;
            if notify.is_some() {
                state.waiters.release(trigger_id).await;
            }
            return Err(error);
        }
    };

    match outcome {
        DispatchOutcome::Sent => {
            sqlx::query(
                "UPDATE trigger_runs SET status = 'dispatched', dispatched_at = now()
                 WHERE id = $1 AND status = 'queued'",
            )
            .bind(trigger_id)
            .execute(&state.pool)
            .await?;
        }
        DispatchOutcome::NoDevice => {
            let retry_at = Utc::now() + chrono::Duration::seconds(NO_DEVICE_RETRY_SECONDS);
            mark_trigger(
                &state,
                trigger_id,
                TriggerUpdate {
                    status: "no_device",
                    exit_code: None,
                    result: None,
                    result_status: Some("not_requested"),
                    error: Some("no connected desktop device".into()),
                    retry_at: Some(retry_at),
                },
            )
            .await?;
            if notify.is_some() {
                state.waiters.release(trigger_id).await;
            }
            let row = fetch_row(&state, trigger_id, user.user_id).await?;
            return Ok((StatusCode::CONFLICT, Json(row_to_view(row))).into_response());
        }
    }

    let Some(notify) = notify else {
        let row = fetch_row(&state, trigger_id, user.user_id).await?;
        return Ok((StatusCode::ACCEPTED, Json(row_to_view(row))).into_response());
    };

    let max = state.config.max_sync_wait_ms;
    let timeout_ms = body.timeout_ms.unwrap_or(max).min(max);
    let waited = wait_terminal(&state, trigger_id, user.user_id, &notify, timeout_ms).await?;
    state.waiters.release(trigger_id).await;

    if waited.is_none() {
        // Timeout is view-only. The database row remains in flight.
        let mut row = fetch_row(&state, trigger_id, user.user_id).await?;
        row.status = "timeout".to_string();
        return Ok((StatusCode::OK, Json(row_to_view(row))).into_response());
    }

    let row = fetch_row(&state, trigger_id, user.user_id).await?;
    Ok((StatusCode::OK, Json(row_to_view(row))).into_response())
}

async fn respond_existing(
    state: &AppState,
    user_id: Uuid,
    trigger_id: Uuid,
    body: &RunRequest,
) -> Result<axum::response::Response, AppError> {
    if !body.wait {
        let row = fetch_row(state, trigger_id, user_id).await?;
        return Ok((StatusCode::ACCEPTED, Json(row_to_view(row))).into_response());
    }
    let row = fetch_row(state, trigger_id, user_id).await?;
    if is_terminal(&row.status) {
        return Ok((StatusCode::OK, Json(row_to_view(row))).into_response());
    }
    let notify = state.waiters.subscribe(trigger_id).await;
    let max = state.config.max_sync_wait_ms;
    let timeout_ms = body.timeout_ms.unwrap_or(max).min(max);
    let waited = wait_terminal(state, trigger_id, user_id, &notify, timeout_ms).await?;
    state.waiters.release(trigger_id).await;
    if waited.is_none() {
        let mut row = fetch_row(state, trigger_id, user_id).await?;
        row.status = "timeout".to_string();
        return Ok(Json(row_to_view(row)).into_response());
    }
    let row = fetch_row(state, trigger_id, user_id).await?;
    Ok(Json(row_to_view(row)).into_response())
}

struct TriggerUpdate<'a> {
    status: &'a str,
    exit_code: Option<i32>,
    result: Option<serde_json::Value>,
    result_status: Option<&'a str>,
    error: Option<String>,
    retry_at: Option<DateTime<Utc>>,
}

async fn mark_trigger(
    state: &AppState,
    trigger_id: Uuid,
    update: TriggerUpdate<'_>,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE trigger_runs
         SET status = $2, exit_code = $3, result = $4, result_status = $5,
             error = $6, retry_at = $7, finished_at = now()
         WHERE id = $1 AND status = 'queued'",
    )
    .bind(trigger_id)
    .bind(update.status)
    .bind(update.exit_code)
    .bind(update.result)
    .bind(update.result_status)
    .bind(update.error)
    .bind(update.retry_at)
    .execute(&state.pool)
    .await?;
    Ok(())
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
    if is_terminal(&row.status) {
        return Ok(Json(row_to_view(row)));
    }

    let notify = state.waiters.subscribe(id).await;
    let max = state.config.max_sync_wait_ms;
    let timeout_ms = params.timeout_ms.unwrap_or(max).min(max);
    let waited = wait_terminal(&state, id, user.user_id, &notify, timeout_ms).await?;
    state.waiters.release(id).await;

    if waited.is_none() {
        let mut row = fetch_row(&state, id, user.user_id).await?;
        row.status = "timeout".to_string();
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
        if is_terminal(&row.status) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_request() -> RunRequest {
        RunRequest {
            device_id: None,
            job: None,
            agent: Some(AgentRequest {
                prompt: "research".into(),
                work_dir: None,
                provider: None,
                model: None,
                effort: None,
                policy: Some(PolicyInput::Name("crm-social-research".into())),
            }),
            params: HashMap::new(),
            provider: None,
            model: None,
            effort: None,
            policy: None,
            idempotency_key: None,
            wait: false,
            timeout_ms: None,
        }
    }

    #[test]
    fn crm_policy_defaults_to_safe_model_and_effort() {
        let normalized = normalize_request(&agent_request()).expect("valid CRM request");
        assert_eq!(normalized.provider.as_deref(), Some("codex"));
        assert_eq!(normalized.model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(normalized.effort.as_deref(), Some("medium"));
        assert_eq!(normalized.policy, Some(JobPolicy::CrmSocialResearch));

        let mut deep_request = agent_request();
        deep_request.agent.as_mut().expect("agent request").effort = Some("max".into());
        let deep = normalize_request(&deep_request).expect("valid deep CRM request");
        assert_eq!(deep.effort.as_deref(), Some("max"));
    }

    #[test]
    fn model_allowlist_rejects_unapproved_values() {
        let error = validate_model_options(
            Some("codex".into()),
            Some("gpt-5.5".into()),
            Some("medium".into()),
            Some(JobPolicy::CrmSocialResearch),
        )
        .expect_err("unapproved model must be rejected");
        assert!(error.to_string().contains("gpt-5.6-luna"));
    }

    #[test]
    fn request_hash_is_independent_of_parameter_insertion_order() {
        let request = normalize_request(&agent_request()).expect("valid CRM request");
        let first = HashMap::from([
            (String::from("b"), String::from("2")),
            (String::from("a"), String::from("1")),
        ]);
        let second = HashMap::from([
            (String::from("a"), String::from("1")),
            (String::from("b"), String::from("2")),
        ]);
        assert_eq!(
            request_hash(&request, None, &first),
            request_hash(&request, None, &second)
        );
    }

    #[test]
    fn policy_resource_name_is_strict() {
        let request = RunRequest {
            policy: Some(PolicyInput::Named(NamedPolicyInput {
                name: "crm_social_research".into(),
                resource_key: Some("different-resource".into()),
            })),
            ..agent_request()
        };
        let error = normalize_request(&request).expect_err("wrong resource must be rejected");
        assert!(error.to_string().contains("android-emulator"));
    }

    #[test]
    fn idempotency_replay_only_accepts_the_same_fingerprint() {
        assert!(validate_idempotent_replay(Some("same"), "same").is_ok());
        let error = validate_idempotent_replay(Some("original"), "retry-with-different-body")
            .expect_err("changed request must conflict");
        assert!(matches!(error, AppError::Conflict(_)));
    }

    #[test]
    fn idempotency_key_requires_matching_header_and_body() {
        let mut body = agent_request();
        body.idempotency_key = Some("crm-run-1".into());
        let mut headers = HeaderMap::new();
        headers.insert(
            "idempotency-key",
            "crm-run-2".parse().expect("header value"),
        );

        let error = idempotency_key(&headers, &body).expect_err("mismatched keys must fail");
        assert!(matches!(error, AppError::BadRequest(_)));
    }
}
