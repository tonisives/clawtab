use std::env;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub listen_addr: String,
    pub self_hosted: bool,
    pub cors_origins: Vec<String>,
    pub max_connections_per_user: usize,

    // Google OAuth (optional)
    pub google_client_id: Option<String>,
    pub google_client_secret: Option<String>,
}

impl Config {
    #[allow(clippy::expect_used)]
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL")
                .expect("DATABASE_URL must be set"),
            jwt_secret: env::var("JWT_SECRET")
                .expect("JWT_SECRET must be set"),
            listen_addr: env::var("LISTEN_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:8080".into()),
            self_hosted: env::var("SELF_HOSTED")
                .map(|v| v == "true" || v == "1")
                .unwrap_or(false),
            cors_origins: env::var("CORS_ORIGINS")
                .map(|v| v.split(',').map(|s| s.trim().to_string()).collect())
                .unwrap_or_default(),
            max_connections_per_user: env::var("MAX_CONNECTIONS_PER_USER")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5),
            google_client_id: env::var("GOOGLE_CLIENT_ID").ok(),
            google_client_secret: env::var("GOOGLE_CLIENT_SECRET").ok(),
        }
    }
}
