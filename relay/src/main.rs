use std::sync::Arc;

use axum::routing::get;
use axum::Router;
use sqlx::PgPool;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod auth;
mod billing;
mod config;
mod db;
mod error;
mod routes;
mod ws;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub pool: PgPool,
    pub hub: Arc<RwLock<ws::Hub>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "clawtab_relay=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = config::Config::from_env();
    let pool = db::create_pool(&config.database_url).await?;
    let hub = Arc::new(RwLock::new(ws::Hub::new()));
    let listen_addr = config.listen_addr.clone();

    let state = AppState {
        config: Arc::new(config),
        pool,
        hub,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .merge(routes::router(state.clone()))
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(&listen_addr).await?;
    tracing::info!("listening on {listen_addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("server shut down");
    Ok(())
}

#[allow(clippy::expect_used)]
async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to listen for ctrl+c");
    tracing::info!("shutdown signal received");
}
