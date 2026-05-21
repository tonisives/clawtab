use uuid::Uuid;

use clawtab_protocol::ClaudeQuestion;

/// A workspace share owned by some other user, accessible to this guest.
pub(super) struct SharedGuest {
    pub guest_id: Uuid,
    pub allowed_groups: Option<Vec<String>>,
}

pub(super) async fn get_shared_guests(pool: &sqlx::PgPool, owner_id: Uuid) -> Vec<SharedGuest> {
    sqlx::query_as::<_, (Uuid, Option<Vec<String>>)>(
        "SELECT guest_id, allowed_groups FROM workspace_shares WHERE owner_id = $1",
    )
    .bind(owner_id)
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

pub(super) async fn get_shared_owner_ids(pool: &sqlx::PgPool, guest_id: Uuid) -> Vec<Uuid> {
    sqlx::query_scalar::<_, Uuid>("SELECT owner_id FROM workspace_shares WHERE guest_id = $1")
        .bind(guest_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
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
