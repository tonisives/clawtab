use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct AddShareRequest {
    pub email: String,
    #[serde(default)]
    pub allowed_groups: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct UpdateShareRequest {
    pub allowed_groups: Option<Vec<String>>,
}

#[derive(Serialize)]
pub struct ShareInfo {
    pub id: Uuid,
    pub email: String,
    pub display_name: Option<String>,
    pub allowed_groups: Option<Vec<String>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct SharedWithMeInfo {
    pub id: Uuid,
    pub owner_email: String,
    pub owner_display_name: Option<String>,
    pub allowed_groups: Option<Vec<String>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct SharesResponse {
    pub shared_by_me: Vec<ShareInfo>,
    pub shared_with_me: Vec<SharedWithMeInfo>,
}

pub async fn add(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<AddShareRequest>,
) -> Result<Json<ShareInfo>, AppError> {
    let email = req.email.trim().to_lowercase();
    if email.is_empty() {
        return Err(AppError::BadRequest("email is required".into()));
    }

    let guest: Option<(Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT id, email, display_name FROM users WHERE LOWER(email) = $1",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;

    let Some((guest_id, guest_email, display_name)) = guest else {
        return Err(AppError::NotFound("no user found with that email".into()));
    };

    if guest_id == claims.sub {
        return Err(AppError::BadRequest("cannot share with yourself".into()));
    }

    let allowed_groups = req.allowed_groups.as_deref();

    let row: (Uuid, DateTime<Utc>) = sqlx::query_as(
        "INSERT INTO workspace_shares (owner_id, guest_id, allowed_groups) VALUES ($1, $2, $3)
         ON CONFLICT (owner_id, guest_id) DO UPDATE SET allowed_groups = $3
         RETURNING id, created_at",
    )
    .bind(claims.sub)
    .bind(guest_id)
    .bind(allowed_groups)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(ShareInfo {
        id: row.0,
        email: guest_email,
        display_name,
        allowed_groups: req.allowed_groups,
        created_at: row.1,
    }))
}

pub async fn list(
    State(state): State<AppState>,
    claims: Claims,
) -> Result<Json<SharesResponse>, AppError> {
    let shared_by_me: Vec<(Uuid, String, Option<String>, Option<Vec<String>>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT ws.id, u.email, u.display_name, ws.allowed_groups, ws.created_at
         FROM workspace_shares ws
         JOIN users u ON u.id = ws.guest_id
         WHERE ws.owner_id = $1
         ORDER BY ws.created_at",
    )
    .bind(claims.sub)
    .fetch_all(&state.pool)
    .await?;

    let shared_with_me: Vec<(Uuid, String, Option<String>, Option<Vec<String>>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT ws.id, u.email, u.display_name, ws.allowed_groups, ws.created_at
         FROM workspace_shares ws
         JOIN users u ON u.id = ws.owner_id
         WHERE ws.guest_id = $1
         ORDER BY ws.created_at",
    )
    .bind(claims.sub)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(SharesResponse {
        shared_by_me: shared_by_me
            .into_iter()
            .map(|(id, email, display_name, allowed_groups, created_at)| ShareInfo {
                id,
                email,
                display_name,
                allowed_groups,
                created_at,
            })
            .collect(),
        shared_with_me: shared_with_me
            .into_iter()
            .map(|(id, owner_email, owner_display_name, allowed_groups, created_at)| SharedWithMeInfo {
                id,
                owner_email,
                owner_display_name,
                allowed_groups,
                created_at,
            })
            .collect(),
    }))
}

pub async fn remove(
    State(state): State<AppState>,
    claims: Claims,
    Path(share_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Allow either the owner or the guest to remove the share
    let result = sqlx::query(
        "DELETE FROM workspace_shares WHERE id = $1 AND (owner_id = $2 OR guest_id = $2)",
    )
    .bind(share_id)
    .bind(claims.sub)
    .execute(&state.pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("share not found".into()));
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn update(
    State(state): State<AppState>,
    claims: Claims,
    Path(share_id): Path<Uuid>,
    Json(req): Json<UpdateShareRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = sqlx::query(
        "UPDATE workspace_shares SET allowed_groups = $1 WHERE id = $2 AND owner_id = $3",
    )
    .bind(req.allowed_groups.as_deref())
    .bind(share_id)
    .bind(claims.sub)
    .execute(&state.pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("share not found".into()));
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}
