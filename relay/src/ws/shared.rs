use uuid::Uuid;

use clawtab_protocol::ClaudeQuestion;

/// A workspace share owned by some other user, accessible to this guest.
pub(super) struct SharedGuest {
    pub guest_id: Uuid,
    pub allowed_groups: Option<Vec<String>>,
}

pub(super) async fn get_shared_guests(
    pool: &sqlx::PgPool,
    owner_id: Uuid,
    device_id: Uuid,
) -> Vec<SharedGuest> {
    sqlx::query_as::<_, (Uuid, Option<Vec<String>>)>(
        "SELECT s.guest_id, s.allowed_groups FROM workspace_shares s JOIN machine_grants g ON g.share_id=s.id WHERE s.owner_id=$1 AND g.device_id=$2",
    )
    .bind(owner_id)
    .bind(device_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|(guest_id, allowed_groups)| SharedGuest {
        guest_id,
        allowed_groups,
    })
    .collect()
}

/// Returns `None` if no filtering is configured (forward as-is).
/// Returns `Some(filtered)` if `allowed_groups` is set, including the empty case.
pub(super) fn filter_questions_for_groups(
    questions: &[ClaudeQuestion],
    allowed_groups: Option<&[String]>,
) -> Option<Vec<ClaudeQuestion>> {
    let groups = allowed_groups?;
    let filtered: Vec<ClaudeQuestion> = questions
        .iter()
        .filter(|q| {
            q.matched_group
                .as_ref()
                .is_some_and(|g| groups.iter().any(|allowed| allowed == g))
        })
        .cloned()
        .collect();
    Some(filtered)
}
