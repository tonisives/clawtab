use redis::AsyncCommands;
use uuid::Uuid;

/// Check if a push notification is allowed for the given user.
/// Uses Redis SET NX EX for atomic rate limiting.
/// Returns true if the push should be sent.
pub async fn allow_push(
    redis: &mut redis::aio::ConnectionManager,
    user_id: Uuid,
    ttl_seconds: u64,
) -> bool {
    let key = format!("push_limit:{}", user_id);
    let result: Result<bool, _> = redis::cmd("SET")
        .arg(&key)
        .arg("1")
        .arg("NX")
        .arg("EX")
        .arg(ttl_seconds)
        .query_async(redis)
        .await;

    result.unwrap_or(false)
}
