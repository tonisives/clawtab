use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub async fn create_pool(database_url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(database_url)
        .await?;

    // Triggers shares the database with the relay. Both crates write into the
    // single `_sqlx_migrations` table, so triggers' migrations are numbered
    // high enough (1000+) to never collide with relay's, and ignore_missing
    // tells the migrator not to error on relay's rows.
    let mut migrator = sqlx::migrate!("./migrations");
    migrator.set_ignore_missing(true);
    migrator.run(&pool).await?;

    tracing::info!("database connected and migrations applied");
    Ok(pool)
}
