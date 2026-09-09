use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

use crate::{auth::Claims, error::AppError, AppState};

pub async fn get_preferences(
    State(state): State<AppState>,
    claims: Claims,
) -> Result<Json<serde_json::Value>, AppError> {
    let row = sqlx::query_as::<_, (Vec<String>, Option<Value>, Value, Value)>(
        "SELECT hidden_groups, agent_models, machine_appearance, job_groups FROM user_preferences WHERE user_id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await?
    .unwrap_or_else(|| (Vec::new(), None, json!({}), json!({})));
    Ok(Json(
        json!({ "hidden_groups": row.0, "agent_models": row.1, "machine_appearance": row.2, "job_groups": row.3 }),
    ))
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Preference {
    Group(GroupPreference),
    JobGroup(JobGroupPreference),
    Models(ModelPreference),
    Machine(MachinePreference),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobGroupPreference {
    job_group: SavedJobGroup,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SavedJobGroup {
    id: Uuid,
    name: String,
    machine_id: Uuid,
    work_dir: String,
}

impl SavedJobGroup {
    fn validate(&self) -> Result<(), AppError> {
        if self.name.trim().is_empty()
            || self.name.len() > 100
            || self.name.chars().any(char::is_control)
            || !self.work_dir.starts_with('/')
            || self.work_dir.len() > 4096
            || self.work_dir.chars().any(char::is_control)
            || self.work_dir.split('/').any(|part| part == "..")
        {
            return Err(AppError::BadRequest("Invalid group name or folder".into()));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupPreference {
    group: String,
    hidden: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelPreference {
    agent_models: AgentModels,
    #[serde(default)]
    initialize: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModels {
    enabled_models: HashMap<String, Vec<String>>,
    default_provider: String,
    default_model: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MachinePreference {
    machine_id: Uuid,
    icon: String,
    color: String,
}

pub async fn set_preferences(
    State(state): State<AppState>,
    claims: Claims,
    Json(preference): Json<Preference>,
) -> Result<Json<Value>, AppError> {
    match preference {
        Preference::Group(group) => return set_hidden_group(&state, claims.sub, group).await,
        Preference::JobGroup(preference) => {
            let group = preference.job_group;
            group.validate()?;
            let changed = sqlx::query("INSERT INTO user_preferences (user_id, job_groups)
                SELECT $1, jsonb_build_object($2::text, $3::jsonb) WHERE EXISTS (SELECT 1 FROM devices WHERE id=$4 AND user_id=$1)
                ON CONFLICT (user_id) DO UPDATE SET job_groups = user_preferences.job_groups || EXCLUDED.job_groups")
                .bind(claims.sub).bind(group.id.to_string())
                .bind(json!(group)).bind(group.machine_id)
                .execute(&state.pool).await?;
            if changed.rows_affected() == 0 {
                return Err(AppError::Forbidden);
            }
        }
        Preference::Models(preference) => {
            let models = preference.agent_models;
            let providers = ["claude", "codex", "opencode", "antigravity", "shell"];
            let valid_id = |id: &str| {
                !id.trim().is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
            };
            if !providers.contains(&models.default_provider.as_str())
                || models.enabled_models.iter().any(|(provider, ids)| {
                    !providers.contains(&provider.as_str())
                        || ids.len() > 256
                        || ids.iter().any(|id| !valid_id(id))
                })
                || models
                    .default_model
                    .as_deref()
                    .is_some_and(|id| !valid_id(id))
            {
                return Err(AppError::BadRequest("Invalid model preferences".into()));
            }
            let models = serde_json::to_value(models)
                .map_err(|_| AppError::BadRequest("Invalid model preferences".into()))?;
            sqlx::query("INSERT INTO user_preferences (user_id, agent_models) VALUES ($1,$2)
                ON CONFLICT (user_id) DO UPDATE SET agent_models =
                CASE WHEN $3 THEN COALESCE(user_preferences.agent_models, EXCLUDED.agent_models) ELSE EXCLUDED.agent_models END")
                .bind(claims.sub).bind(models).bind(preference.initialize).execute(&state.pool).await?;
        }
        Preference::Machine(preference) => {
            if !["desktop", "laptop", "server", "terminal", "chip"]
                .contains(&preference.icon.as_str())
                || preference.color.len() != 7
                || !preference.color.starts_with('#')
                || !preference.color[1..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(AppError::BadRequest("Invalid machine appearance".into()));
            }
            let changed = sqlx::query("INSERT INTO user_preferences (user_id, machine_appearance)
                SELECT $1, jsonb_build_object($2::text, $3::jsonb) WHERE EXISTS (SELECT 1 FROM devices WHERE id=$4 AND user_id=$1)
                ON CONFLICT (user_id) DO UPDATE SET machine_appearance = user_preferences.machine_appearance || EXCLUDED.machine_appearance")
                .bind(claims.sub).bind(preference.machine_id.to_string())
                .bind(json!({"icon":preference.icon,"color":preference.color})).bind(preference.machine_id)
                .execute(&state.pool).await?;
            if changed.rows_affected() == 0 {
                return Err(AppError::Forbidden);
            }
        }
    }
    get_preferences(State(state), claims).await
}

async fn set_hidden_group(
    state: &AppState,
    user: Uuid,
    preference: GroupPreference,
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
    .bind(user)
    .bind(preference.group)
    .bind(preference.hidden)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(serde_json::json!({ "hidden_groups": groups })))
}
