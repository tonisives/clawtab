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
    // SET key 1 NX EX ttl - returns OK if set (key was new), nil if already exists
    let result: Result<Option<String>, _> = redis::cmd("SET")
        .arg(&key)
        .arg("1")
        .arg("NX")
        .arg("EX")
        .arg(ttl_seconds)
        .query_async(redis)
        .await;

    // Some("OK") means the key was set (not rate limited)
    // None means the key already existed (rate limited)
    matches!(result, Ok(Some(_)))
}
