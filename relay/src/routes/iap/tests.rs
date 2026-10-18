#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use chrono::{Duration, Utc};

async fn fixture() -> PgPool {
    let url = std::env::var("IAP_TEST_DATABASE_URL").expect("disposable database required");
    assert!(url.starts_with("postgresql://postgres@127.0.0.1:55439/"));
    let pool = crate::db::create_pool(&url).await.unwrap();
    pool
}
async fn user(pool: &PgPool) -> Uuid {
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES ($1,$2,'test')")
        .bind(user)
        .bind(format!("{user}@test.invalid"))
        .execute(pool)
        .await
        .unwrap();
    user
}
fn purchase(user: Uuid) -> apple::VerifiedTransaction {
    let now = Utc::now();
    apple::VerifiedTransaction {
        transaction_id: Uuid::new_v4().to_string(),
        original_transaction_id: Uuid::new_v4().to_string(),
        product_id: "cc.clawtab.pro.monthly".into(),
        environment: "Sandbox",
        purchase_date: now - Duration::minutes(1),
        expires_date: now + Duration::minutes(5),
        signed_date: now,
        revocation_date: None,
        is_upgraded: false,
        app_account_token: Some(user),
    }
}
async fn save(pool: &PgPool, user: Uuid, purchase: &apple::VerifiedTransaction) {
    let mut tx = pool.begin().await.unwrap();
    let owner = transaction_owner(&mut tx, purchase).await.unwrap();
    assert!(owner.is_none_or(|owner| owner == user));
    persist_transaction(&mut tx, user, purchase).await.unwrap();
    tx.commit().await.unwrap();
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL on port 55439"]
async fn apple_expiry_refund_and_stale_updates_preserve_independent_stripe() {
    let pool = fixture().await;
    let user = user(&pool).await;
    sqlx::query("INSERT INTO subscriptions(user_id,stripe_subscription_id,status,current_period_end) VALUES ($1,'test-plan','active',now()+interval '1 month')")
        .bind(user).execute(&pool).await.unwrap();
    let mut purchase = purchase(user);
    save(&pool, user, &purchase).await;
    assert!(apple_access(&pool, user).await.unwrap());
    purchase.revocation_date = Some(Utc::now());
    purchase.signed_date += Duration::seconds(1);
    save(&pool, user, &purchase).await;
    assert!(!apple_access(&pool, user).await.unwrap());
    purchase.revocation_date = None;
    purchase.signed_date -= Duration::seconds(1);
    save(&pool, user, &purchase).await;
    assert!(
        !apple_access(&pool, user).await.unwrap(),
        "stale restore revived refund"
    );
    purchase.purchase_date += Duration::minutes(1);
    purchase.signed_date += Duration::seconds(2);
    save(&pool, user, &purchase).await;
    assert!(apple_access(&pool, user).await.unwrap());
    sqlx::query(
        "UPDATE apple_subscriptions SET expires_date=now()-interval '1 second' WHERE user_id=$1",
    )
    .bind(user)
    .execute(&pool)
    .await
    .unwrap();
    assert!(
        !apple_access(&pool, user).await.unwrap(),
        "access survived expiry without a notification"
    );
    let status: String = sqlx::query_scalar("SELECT status FROM subscriptions WHERE user_id=$1")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "active");
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL on port 55439"]
async fn ownership_is_retained_and_notifications_are_idempotent_and_ordered() {
    let pool = fixture().await;
    let user = user(&pool).await;
    let purchase = purchase(user);
    let original = purchase.original_transaction_id.clone();
    let notification_id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let notification = apple::VerifiedNotification {
        id: notification_id.clone(),
        notification_type: "DID_CHANGE_RENEWAL_STATUS".into(),
        environment: "Sandbox",
        transaction: Some(purchase),
        signed_date: now,
        auto_renew: Some(false),
        renewal_signed_date: Some(now),
        grace_period_expires_date: None,
    };
    apply_notification(&pool, notification).await.unwrap();
    assert!(
        apple_access(&pool, user).await.unwrap(),
        "canceling renewal removed paid access"
    );
    let mut restored = purchase_for_original(user, &original);
    let mut tx = pool.begin().await.unwrap();
    assert_eq!(
        transaction_owner(&mut tx, &restored).await.unwrap(),
        Some(user)
    );
    tx.rollback().await.unwrap();
    restored.revocation_date = Some(now);
    apply_notification(
        &pool,
        apple::VerifiedNotification {
            id: notification_id,
            notification_type: "REFUND".into(),
            environment: "Sandbox",
            transaction: Some(restored),
            signed_date: now + Duration::seconds(1),
            auto_renew: Some(true),
            renewal_signed_date: Some(now - Duration::seconds(1)),
            grace_period_expires_date: None,
        },
    )
    .await
    .unwrap();
    assert!(
        apple_access(&pool, user).await.unwrap(),
        "duplicate notification was applied twice"
    );
    let auto: bool =
        sqlx::query_scalar("SELECT auto_renew FROM apple_subscriptions WHERE user_id=$1")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!auto);
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
}
fn purchase_for_original(user: Uuid, original: &str) -> apple::VerifiedTransaction {
    let mut value = purchase(user);
    value.original_transaction_id = original.into();
    value
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL on port 55439"]
async fn account_tokens_and_first_claims_prevent_cross_account_restores() {
    let pool = fixture().await;
    let first = user(&pool).await;
    let second = user(&pool).await;
    let mut purchase = purchase(first);
    assert!(matches!(
        activate_transaction(&pool, second, &purchase).await,
        Err(AppError::Conflict(_))
    ));
    purchase.app_account_token = None;
    assert!(activate_transaction(&pool, first, &purchase).await.unwrap());
    assert!(matches!(
        activate_transaction(&pool, second, &purchase).await,
        Err(AppError::Conflict(_))
    ));
    assert!(!apple_access(&pool, second).await.unwrap());
    sqlx::query("DELETE FROM users WHERE id=ANY($1)")
        .bind(vec![first, second])
        .execute(&pool)
        .await
        .unwrap();
}
