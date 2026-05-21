use uuid::Uuid;

use clawtab_protocol::ClaudeQuestion;

use crate::AppState;

const CONTENT_DEDUP_TTL_SECONDS: u64 = 300;

pub(super) async fn handle_claude_questions_push(
    state: &AppState,
    user_id: Uuid,
    questions: &[ClaudeQuestion],
) {
    // Drop questions for panes the user has auto-yes enabled on.
    let questions: Vec<&ClaudeQuestion> = {
        let hub = state.hub.read().await;
        questions
            .iter()
            .filter(|q| !hub.is_auto_yes_pane(user_id, &q.pane_id))
            .collect()
    };
    if questions.is_empty() {
        return;
    }

    persist_questions(state, user_id, &questions).await;

    let Some(q) = pick_unpushed(state, user_id, &questions).await else {
        tracing::debug!(%user_id, "all questions already pushed");
        return;
    };

    let Some(ref apns) = state.apns else {
        return;
    };

    let tokens = fetch_ios_push_tokens(state, user_id).await;
    if tokens.is_empty() {
        return;
    }

    // Compact the path: keep the last folder plus a shortened prefix.
    // "/Users/tonis/workspace/tgs/clawtab/public" -> "~/w/t/clawtab/public"
    let title = crate::notification_fmt::compact_cwd(&q.cwd);
    let body = crate::notification_fmt::format_body(&q.context_lines, &q.options);

    // Include all options so the NSE can build text-input actions for
    // overflow (iOS shows max 4 buttons; we add a text input above that).
    let options: Vec<(String, String)> = q
        .options
        .iter()
        .map(|o| (o.number.clone(), o.label.clone()))
        .collect();

    let invalid = send_question_to_tokens(apns, user_id, q, &title, &body, &options, &tokens).await;
    delete_invalid_tokens(state, &invalid).await;
}

async fn send_question_to_tokens(
    apns: &crate::apns::ApnsClient,
    user_id: Uuid,
    q: &ClaudeQuestion,
    title: &str,
    body: &str,
    options: &[(String, String)],
    tokens: &[(Uuid, String)],
) -> Vec<Uuid> {
    let mut invalid = Vec::new();
    for (token_id, device_token) in tokens {
        let res = apns
            .send_question_notification(
                device_token,
                title,
                body,
                &q.question_id,
                &q.pane_id,
                q.matched_job.as_deref(),
                options,
            )
            .await;
        classify_push_result(res, *token_id, user_id, "push", &mut invalid);
    }
    invalid
}

fn classify_push_result(
    res: Result<(), String>,
    token_id: Uuid,
    user_id: Uuid,
    kind: &str,
    invalid: &mut Vec<Uuid>,
) {
    match res {
        Ok(()) => tracing::info!(%user_id, "{kind} sent"),
        Err(e) if e.starts_with("invalid_token:") => {
            tracing::warn!(%user_id, "removing invalid push token");
            invalid.push(token_id);
        }
        Err(e) => tracing::error!(%user_id, "{kind} failed: {e}"),
    }
}

async fn persist_questions(state: &AppState, user_id: Uuid, questions: &[&ClaudeQuestion]) {
    for q in questions {
        let options_json = serde_json::to_value(&q.options).unwrap_or_default();
        let res = sqlx::query(
            "INSERT INTO notification_history (user_id, question_id, pane_id, cwd, context_lines, options)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (question_id) DO NOTHING",
        )
        .bind(user_id)
        .bind(&q.question_id)
        .bind(&q.pane_id)
        .bind(&q.cwd)
        .bind(&q.context_lines)
        .bind(&options_json)
        .execute(&state.pool)
        .await;
        if let Err(e) = res {
            tracing::warn!(%user_id, question_id = %q.question_id, "persist failed: {e}");
        }
    }
}

/// Two layers of dedup:
///   1. question_id (pane_id + options hash) for 24h - the primary check
///   2. content hash (user + cwd + options) for 5 min - safety net for cases
///      where the question_id drifts (pane_id changes, options reparsed
///      slightly differently) and the user already saw the same prompt.
async fn pick_unpushed<'a>(
    state: &AppState,
    user_id: Uuid,
    questions: &'a [&'a ClaudeQuestion],
) -> Option<&'a ClaudeQuestion> {
    let Some(ref redis) = state.redis else {
        return questions.first().copied();
    };
    let mut conn = redis.clone();
    for q in questions {
        if crate::push_limiter::is_question_pushed(&mut conn, &q.question_id).await {
            continue;
        }
        if crate::push_limiter::is_content_pushed(
            &mut conn,
            user_id,
            &q.cwd,
            &q.options,
            CONTENT_DEDUP_TTL_SECONDS,
        )
        .await
        {
            tracing::debug!(question_id = %q.question_id, "content already pushed recently");
            continue;
        }
        return Some(*q);
    }
    None
}

async fn fetch_ios_push_tokens(state: &AppState, user_id: Uuid) -> Vec<(Uuid, String)> {
    sqlx::query_as(
        "SELECT id, push_token FROM push_tokens WHERE user_id = $1 AND platform = 'ios'",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default()
}

async fn delete_invalid_tokens(state: &AppState, token_ids: &[Uuid]) {
    for token_id in token_ids {
        sqlx::query("DELETE FROM push_tokens WHERE id = $1")
            .bind(token_id)
            .execute(&state.pool)
            .await
            .ok();
    }
}

pub(super) async fn handle_job_notification_push(
    state: &AppState,
    user_id: Uuid,
    job_id: &str,
    event: &str,
    run_id: &str,
) {
    let Some(ref apns) = state.apns else {
        return;
    };

    if !claim_job_push_slot(state, user_id, job_id, event).await {
        tracing::debug!(%user_id, %job_id, %event, "job push deduped");
        return;
    }

    let tokens = fetch_ios_push_tokens(state, user_id).await;
    if tokens.is_empty() {
        return;
    }

    let mut invalid = Vec::new();
    for (token_id, device_token) in &tokens {
        let res = apns
            .send_job_notification(device_token, job_id, event, run_id)
            .await;
        classify_push_result(res, *token_id, user_id, "job push", &mut invalid);
    }
    delete_invalid_tokens(state, &invalid).await;
}

/// Per-job dedup via Redis SET NX with a 30s TTL. Returns true if this caller
/// won the slot; false if a duplicate fired recently.
async fn claim_job_push_slot(state: &AppState, user_id: Uuid, job_id: &str, event: &str) -> bool {
    let Some(ref redis) = state.redis else {
        return true; // no redis = no dedup
    };
    let mut conn = redis.clone();
    let key = format!("job_push:{user_id}:{job_id}:{event}");
    let result: Result<Option<String>, _> = redis::cmd("SET")
        .arg(&key)
        .arg("1")
        .arg("NX")
        .arg("EX")
        .arg(30_u64)
        .query_async(&mut conn)
        .await;
    matches!(result, Ok(Some(_)))
}

/// Persist a trigger run result and notify any waiters in the triggers service.
pub(super) async fn handle_trigger_result(
    state: &AppState,
    user_id: Uuid,
    trigger_id: &str,
    status: &str,
    exit_code: Option<i32>,
    result: &Option<serde_json::Value>,
    error: &Option<String>,
) {
    let Ok(id) = Uuid::parse_str(trigger_id) else {
        tracing::warn!(%trigger_id, "trigger_result with malformed id");
        return;
    };

    let final_status = normalize_trigger_status(status);
    let updated = update_trigger_run(state, id, user_id, final_status, exit_code, result, error).await;
    handle_trigger_update_outcome(state, id, updated).await;
}

fn normalize_trigger_status(status: &str) -> &str {
    match status {
        "succeeded" | "failed" => status,
        other => {
            tracing::warn!(%other, "trigger_result unexpected status, coercing to failed");
            "failed"
        }
    }
}

async fn update_trigger_run(
    state: &AppState,
    id: Uuid,
    user_id: Uuid,
    status: &str,
    exit_code: Option<i32>,
    result: &Option<serde_json::Value>,
    error: &Option<String>,
) -> Result<sqlx::postgres::PgQueryResult, sqlx::Error> {
    sqlx::query(
        "UPDATE trigger_runs
         SET status = $1, exit_code = $2, result = $3, error = $4, finished_at = now()
         WHERE id = $5 AND user_id = $6 AND status NOT IN ('succeeded', 'failed', 'no_device')",
    )
    .bind(status)
    .bind(exit_code)
    .bind(result)
    .bind(error)
    .bind(id)
    .bind(user_id)
    .execute(&state.pool)
    .await
}

async fn handle_trigger_update_outcome(
    state: &AppState,
    id: Uuid,
    updated: Result<sqlx::postgres::PgQueryResult, sqlx::Error>,
) {
    match updated {
        Ok(res) if res.rows_affected() > 0 => notify_trigger_result(state, id).await,
        Ok(_) => tracing::debug!(%id, "trigger_result ignored (already terminal or wrong owner)"),
        Err(e) => tracing::warn!(%id, "failed to persist trigger_result: {e}"),
    }
}

async fn notify_trigger_result(state: &AppState, id: Uuid) {
    if let Err(e) = sqlx::query("SELECT pg_notify('trigger_result', $1)")
        .bind(id.to_string())
        .execute(&state.pool)
        .await
    {
        tracing::warn!(%id, "pg_notify trigger_result failed: {e}");
    }
}
