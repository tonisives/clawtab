mod answer;
mod health;
mod register;
mod login;
mod refresh;
mod device;
mod debug;
mod google_auth;
mod google_callback;
mod notifications;
mod subscription;

use std::sync::Arc;

use axum::extract::Request;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::Router;
use http_body_util::BodyExt;
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::key_extractor::SmartIpKeyExtractor;
use tower_governor::GovernorLayer;

use crate::auth::auth_middleware;
use crate::AppState;

async fn log_errors(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let uri = req.uri().path().to_string();
    let response = next.run(req).await;
    let status = response.status();

    if status.is_client_error() || status.is_server_error() {
        let (parts, body) = response.into_parts();
        let bytes = body.collect().await.map(http_body_util::Collected::to_bytes).unwrap_or_default();
        let body_str = String::from_utf8_lossy(&bytes);
        tracing::error!("{} {} -> {} {}", method, uri, status, body_str);
        Response::from_parts(parts, axum::body::Body::from(bytes))
    } else {
        response
    }
}

#[allow(clippy::expect_used)]
pub fn router(state: AppState) -> Router<AppState> {
    // Rate limiter: 10 requests/minute per IP (burst 10, replenish 1 per 6 seconds)
    let rate_limit_config = Arc::new(
        GovernorConfigBuilder::default()
            .key_extractor(SmartIpKeyExtractor)
            .per_second(6)
            .burst_size(10)
            .finish()
            .expect("invalid rate limit config"),
    );

    let public = Router::new()
        .route("/health", get(health::health));

    let rate_limited_auth = Router::new()
        .route("/auth/register", post(register::register))
        .route("/auth/login", post(login::login))
        .route("/auth/refresh", post(refresh::refresh))
        .route("/auth/google", post(google_auth::google_auth))
        .route("/auth/google/callback", get(google_callback::google_callback))
        .layer(GovernorLayer { config: rate_limit_config });

    let authenticated = Router::new()
        .route("/devices/pair", post(device::pair))
        .route("/devices", get(device::list))
        .route("/devices/{id}", delete(device::remove))
        .route("/subscription/status", get(subscription::status))
        .route("/notifications/history", get(notifications::history))
        .route("/debug/test-push", post(debug::test_push))
        .route("/api/answer", post(answer::answer))
        .layer(middleware::from_fn_with_state(state, auth_middleware));

    public
        .merge(rate_limited_auth)
        .merge(authenticated)
        .layer(middleware::from_fn(log_errors))
}
