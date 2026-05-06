use std::sync::Arc;

use axum::Router;
use sqlx::PgPool;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod auth;
mod config;
mod db;
mod dispatch;
mod error;
mod janitor;
mod notify;
mod routes;

use crate::config::Config;
use crate::dispatch::Dispatcher;
use crate::notify::ResultWaiters;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub pool: PgPool,
    pub waiters: ResultWaiters,
    pub dispatcher: Arc<Dispatcher>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "clawtab_triggers=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Arc::new(Config::from_env()?);
    let pool = db::create_pool(&config.database_url).await?;
    let listen_addr = config.listen_addr.clone();

    let waiters = ResultWaiters::new();
    notify::spawn_listener(pool.clone(), waiters.clone());
    janitor::spawn(pool.clone());

    let dispatcher = Arc::new(Dispatcher::new(Arc::clone(&config)));

    let state = AppState { config, pool, waiters, dispatcher };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .merge(routes::router(state.clone()))
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(&listen_addr).await?;
    tracing::info!("triggers listening on {listen_addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("triggers shut down");
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}
