use axum::extract::State;
use axum::Json;

use crate::auth::Claims;
use crate::error::AppError;
use crate::AppState;

pub async fn delete_account(
    State(state): State<AppState>,
    claims: Claims,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(claims.sub)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("account not found".into()));
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}
