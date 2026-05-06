use std::time::Duration;

use sqlx::PgPool;

pub fn spawn(pool: PgPool) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            match sqlx::query("DELETE FROM trigger_runs WHERE expires_at < now()")
                .execute(&pool)
                .await
            {
                Ok(res) => {
                    let n = res.rows_affected();
                    if n > 0 {
                        tracing::info!("janitor: purged {n} expired trigger_runs rows");
                    }
                }
                Err(e) => tracing::warn!("janitor: purge failed: {e}"),
            }
        }
    });
}
