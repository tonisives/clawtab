use std::env;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub listen_addr: String,
    pub relay_internal_url: String,
    pub relay_internal_secret: String,
    pub max_sync_wait_ms: u64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            database_url: env::var("DATABASE_URL")
                .map_err(|_| anyhow::anyhow!("DATABASE_URL must be set"))?,
            jwt_secret: env::var("JWT_SECRET")
                .map_err(|_| anyhow::anyhow!("JWT_SECRET must be set"))?,
            listen_addr: env::var("TRIGGERS_LISTEN_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:8090".into()),
            relay_internal_url: env::var("RELAY_INTERNAL_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8080".into()),
            relay_internal_secret: env::var("RELAY_INTERNAL_SECRET")
                .map_err(|_| anyhow::anyhow!("RELAY_INTERNAL_SECRET must be set"))?,
            max_sync_wait_ms: env::var("TRIGGERS_MAX_SYNC_WAIT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60_000),
        })
    }
}
