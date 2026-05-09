use clawtab_protocol::QuestionOption;
use uuid::Uuid;

/// Check if a push has already been sent for this specific question.
/// Prevents duplicate pushes when the desktop re-broadcasts the same questions.
/// TTL is 24 hours - long enough that unanswered questions won't re-notify.
pub async fn is_question_pushed(
    redis: &mut redis::aio::ConnectionManager,
    question_id: &str,
) -> bool {
    let key = format!("pushed_q:{question_id}");
    let result: Result<Option<String>, _> = redis::cmd("SET")
        .arg(&key)
        .arg("1")
        .arg("NX")
        .arg("EX")
        .arg(86400_u64)
        .query_async(redis)
        .await;

    // Returns false if key was newly set (not yet pushed)
    // Returns true if key already existed (already pushed)
    !matches!(result, Ok(Some(_)))
}

/// Content-based dedup: suppress pushes for the same (user, cwd, options) within
/// a short window. Catches duplicates that slip past the question_id dedup, e.g.
/// if pane ids change or options get reparsed slightly differently across captures.
///
/// Returns true if a push for this content was already sent within the window.
pub async fn is_content_pushed(
    redis: &mut redis::aio::ConnectionManager,
    user_id: Uuid,
    cwd: &str,
    options: &[QuestionOption],
    ttl_seconds: u64,
) -> bool {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    cwd.hash(&mut hasher);
    for opt in options {
        opt.number.hash(&mut hasher);
        opt.label.trim().hash(&mut hasher);
    }
    let key = format!("pushed_c:{user_id}:{:x}", hasher.finish());
    let result: Result<Option<String>, _> = redis::cmd("SET")
        .arg(&key)
        .arg("1")
        .arg("NX")
        .arg("EX")
        .arg(ttl_seconds)
        .query_async(redis)
        .await;

    !matches!(result, Ok(Some(_)))
}
