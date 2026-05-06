use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub async fn create_pool(database_url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(database_url)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    tracing::info!("database connected and migrations applied");
    Ok(pool)
}
