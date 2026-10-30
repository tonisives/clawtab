//! Low-frequency repair of missed lifecycle hooks, independent of TUI polling.
use super::*;
use std::collections::VecDeque;
use std::time::Instant;

const ROUND_INTERVAL: Duration = Duration::from_secs(600);
const PROBE_SPACING: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Queue {
    round_at: Option<Instant>,
    pending: VecDeque<HookEventV1>,
    checked: HashMap<String, (Instant, u64, u32)>,
}

impl Queue {
    fn round_due(&self, now: Instant) -> bool {
        self.pending.is_empty()
            && self
                .round_at
                .is_none_or(|at| now.duration_since(at) >= ROUND_INTERVAL)
    }

    fn next(
        &mut self,
        candidates: Vec<HookEventV1>,
        now: Instant,
        wall_ms: u64,
    ) -> Option<HookEventV1> {
        if self.round_due(now) {
            let live: HashSet<_> = candidates.iter().map(HookEventV1::storage_key).collect();
            self.checked.retain(|key, _| live.contains(key));
            let mut eligible: Vec<_> = candidates
                .into_iter()
                .filter(|event| {
                    if wall_ms.saturating_sub(event.occurred_at_ms)
                        < ROUND_INTERVAL.as_millis() as u64
                    {
                        return false;
                    }
                    self.checked
                        .get(&event.storage_key())
                        .is_none_or(|(at, hook_at, misses)| {
                            let backoff = if *hook_at == event.occurred_at_ms {
                                1 << (*misses).min(3)
                            } else {
                                1
                            };
                            now.duration_since(*at) >= ROUND_INTERVAL * backoff
                        })
                })
                .collect();
            // Older working markers first; permission/question states follow.
            eligible.sort_by_key(|event| {
                (
                    event.state == HookAgentState::Waiting,
                    event.occurred_at_ms,
                    event.storage_key(),
                )
            });
            self.pending = eligible.into();
            // Startup can precede the first pane binding. Try again on the next
            // cheap timer tick until the initial live set becomes available.
            if !live.is_empty() || self.round_at.is_some() {
                self.round_at = Some(now);
            }
        }
        let event = self.pending.pop_front()?;
        let previous = self.checked.get(&event.storage_key());
        let misses = previous
            .filter(|(_, hook_at, _)| *hook_at == event.occurred_at_ms)
            .map_or(0, |(_, _, misses)| *misses);
        self.checked
            .insert(event.storage_key(), (now, event.occurred_at_ms, misses));
        Some(event)
    }

    fn unresolved(&mut self, event: &HookEventV1) {
        if let Some((_, _, misses)) = self.checked.get_mut(&event.storage_key()) {
            *misses = misses.saturating_add(1);
        }
    }
}

fn candidates(runtime: &HookRuntime) -> Vec<HookEventV1> {
    // Release the session lock before consulting pane bindings.
    let events: Vec<_> = runtime
        .sessions
        .lock()
        .values()
        .filter(|event| {
            !event.ended
                && event.state != HookAgentState::Idle
                && matches!(
                    event.provider,
                    ProcessProvider::Claude
                        | ProcessProvider::Codex
                        | ProcessProvider::Opencode
                        | ProcessProvider::Hermes
                )
        })
        .cloned()
        .collect();
    events
        .into_iter()
        .filter(|event| !runtime.event_panes(event).is_empty())
        .collect()
}

pub(super) async fn run(runtime: HookRuntime) {
    let mut queue = Queue::default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(250))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .expect("local status client");
    let mut ticks = tokio::time::interval(PROBE_SPACING);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticks.tick().await;
        let now = Instant::now();
        let events = if queue.round_due(now) {
            candidates(&runtime)
        } else {
            Vec::new()
        };
        let Some(observed) = queue.next(events, now, now_ms()) else {
            continue;
        };
        let key = observed.storage_key();
        if runtime.sessions.lock().get(&key).is_none_or(|current| {
            current.occurred_at_ms != observed.occurred_at_ms
                || current.state != observed.state
                || current.ended
        }) || runtime.event_panes(&observed).is_empty()
        {
            continue;
        }
        // No pane captures, process spawning, recursive discovery or provider
        // writes. A slow database read runs outside the hook/approval loop.
        let evidence = crate::agent_session::lifecycle::terminal_after(&client, &observed).await;
        let Some(evidence) = evidence else {
            queue.unresolved(&observed);
            continue;
        };
        let repaired = {
            let mut sessions = runtime.sessions.lock();
            if let Some(current) = sessions.get_mut(&key) {
                if reconcile_completed_turn(current, &observed, evidence.at_ms) {
                    current.event = evidence.event.to_string();
                    if let Err(error) = persist_session_event(current) {
                        log::warn!("[agent-hooks] could not persist recovery: {}", error);
                    }
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };
        if repaired {
            log::info!(
                "[agent-hooks] repaired {} lifecycle for {}",
                observed.provider.as_str(),
                observed.session_id
            );
            runtime.wake_question_detection();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(id: &str, state: HookAgentState) -> HookEventV1 {
        let mut event = HookEventV1::from_provider_payload(
            ProcessProvider::Claude,
            "user_prompt_submit",
            &json!({"session_id": id}),
            Some("%1".into()),
            Some(1),
        )
        .unwrap();
        event.occurred_at_ms = 1;
        event.state = state;
        event
    }

    #[test]
    fn rounds_spread_checks_and_prioritize_old_working_markers() {
        let now = Instant::now();
        let mut queue = Queue::default();
        let events = vec![
            event("waiting", HookAgentState::Waiting),
            event("working", HookAgentState::Working),
        ];
        assert_eq!(
            queue.next(events.clone(), now, 700_000).unwrap().session_id,
            "working"
        );
        assert_eq!(
            queue
                .next(events.clone(), now + PROBE_SPACING, 705_000)
                .unwrap()
                .session_id,
            "waiting"
        );
        assert!(queue
            .next(events.clone(), now + Duration::from_secs(599), 1_299_000)
            .is_none());
        // Per-session spacing holds even when the previous round spanned ticks.
        assert_eq!(
            queue
                .next(events.clone(), now + ROUND_INTERVAL, 1_300_000)
                .unwrap()
                .session_id,
            "working"
        );
        assert!(queue
            .next(events, now + ROUND_INTERVAL + PROBE_SPACING, 1_305_000)
            .is_none());
    }

    #[test]
    fn unresolved_states_back_off_and_new_hooks_keep_the_minimum_interval() {
        let now = Instant::now();
        let mut queue = Queue::default();
        let event = event("one", HookAgentState::Working);
        assert!(queue.next(vec![event.clone()], now, 700_000).is_some());
        queue.unresolved(&event);
        assert!(queue
            .next(vec![event.clone()], now + ROUND_INTERVAL, 1_300_000)
            .is_none());
        assert!(queue
            .next(vec![event.clone()], now + ROUND_INTERVAL * 2, 1_900_000)
            .is_some());
        let mut newer = event;
        newer.occurred_at_ms = 700_000;
        queue.round_at = None;
        assert!(queue
            .next(
                vec![newer],
                now + ROUND_INTERVAL * 2 + PROBE_SPACING,
                1_905_000
            )
            .is_none());
    }

    #[test]
    fn startup_waits_for_bindings_and_recent_hooks() {
        let now = Instant::now();
        let mut queue = Queue::default();
        assert!(queue.next(vec![], now, 700_000).is_none());
        assert!(queue
            .next(
                vec![event("one", HookAgentState::Working)],
                now + PROBE_SPACING,
                705_000
            )
            .is_some());
        let mut recent = Queue::default();
        assert!(recent
            .next(vec![event("new", HookAgentState::Working)], now, 599_999)
            .is_none());
    }
}
