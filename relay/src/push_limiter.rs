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
