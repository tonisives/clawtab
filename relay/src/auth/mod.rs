mod password;
mod jwt;
pub mod google;

pub use password::{hash_password, verify_password};
pub use jwt::{Claims, create_access_token, validate_access_token};

use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::middleware::Next;
use axum::response::Response;

use crate::error::AppError;
use crate::AppState;

/// Middleware that validates JWT from Authorization header and inserts Claims into request extensions.
pub async fn auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let header = req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    let token = header.ok_or(AppError::Unauthorized)?;
    let claims = validate_access_token(token, &state.config.jwt_secret)?;
    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}

/// Extractor for authenticated user claims.
impl<S> FromRequestParts<S> for Claims
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts.extensions.get::<Claims>()
            .cloned()
            .ok_or(AppError::Unauthorized)
    }
}
