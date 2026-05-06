pub mod api_tokens;
pub mod triggers;

use axum::middleware;
use axum::routing::{delete, get, post};
use axum::Router;

use crate::auth::{api_token_middleware, jwt_middleware};
use crate::AppState;

pub fn router(state: AppState) -> Router<AppState> {
    let token_management = Router::new()
        .route("/api/tokens", post(api_tokens::create))
        .route("/api/tokens", get(api_tokens::list))
        .route("/api/tokens/{id}", delete(api_tokens::revoke))
        .layer(middleware::from_fn_with_state(state.clone(), jwt_middleware));

    let triggers_api = Router::new()
        .route("/v1/triggers/run", post(triggers::run))
        .route("/v1/triggers/{id}", get(triggers::get_one))
        .route("/v1/triggers/{id}/wait", get(triggers::wait_for))
        .layer(middleware::from_fn_with_state(state, api_token_middleware));

    let public = Router::new().route("/health", get(|| async { "ok" }));

    public.merge(token_management).merge(triggers_api)
}
