use axum::{extract::State, Json};
use serde::Deserialize;

use crate::{auth::Claims, error::AppError, AppState};

pub async fn get_preferences(
    State(state): State<AppState>,
    claims: Claims,
) -> Result<Json<serde_json::Value>, AppError> {
    let groups = sqlx::query_scalar::<_, Vec<String>>(
        "SELECT hidden_groups FROM user_preferences WHERE user_id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await?
    .unwrap_or_default();
    Ok(Json(serde_json::json!({ "hidden_groups": groups })))
}

#[derive(Deserialize)]
pub struct GroupPreference {
    group: String,
    hidden: bool,
}

pub async fn set_hidden_group(
    State(state): State<AppState>,
    claims: Claims,
    Json(preference): Json<GroupPreference>,
) -> Result<Json<serde_json::Value>, AppError> {
    if preference.group.len() > 1024 {
        return Err(AppError::BadRequest("Group name is too long".into()));
    }
    // Change one group atomically so other devices' preferences are preserved.
    let groups = sqlx::query_scalar::<_, Vec<String>>(
        "INSERT INTO user_preferences (user_id, hidden_groups)
         VALUES ($1, CASE WHEN $3 THEN ARRAY[$2]::text[] ELSE '{}'::text[] END)
         ON CONFLICT (user_id) DO UPDATE SET hidden_groups =
           CASE WHEN $3 THEN ARRAY(SELECT DISTINCT unnest(array_append(user_preferences.hidden_groups, $2)))
                ELSE array_remove(user_preferences.hidden_groups, $2) END
         RETURNING hidden_groups",
    )
    .bind(claims.sub)
    .bind(preference.group)
    .bind(preference.hidden)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(serde_json::json!({ "hidden_groups": groups })))
}
