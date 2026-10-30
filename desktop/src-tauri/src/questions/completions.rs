use super::{claude_working_status, DetectedAgent};
use crate::agent_hooks::{HookAgentState, HookPaneState, HookRuntime};
use crate::agent_session::{ProcessProvider, ProcessSnapshot};
use crate::ipc::AgentActivity;
use crate::nfn::NfnSource;
use std::collections::{HashMap, HashSet};

#[derive(Clone, PartialEq, Eq)]
pub(super) struct ProcessIdentity {
    pid: String,
    started_at: Option<i64>,
}

pub(super) fn process_identity(
    pane_pid: &str,
    snapshot: &ProcessSnapshot,
) -> Option<ProcessIdentity> {
    let pid = crate::agent_session::provider_process_pid(pane_pid, snapshot)?;
    Some(ProcessIdentity {
        started_at: snapshot.start_epoch_for_pid(&pid),
        pid,
    })
}

struct State {
    process: ProcessIdentity,
    session: Option<String>,
    active: bool,
    failed: bool,
    hook_at: u64,
    action_at: Option<u64>,
}

#[derive(Default)]
pub(super) struct Tracker {
    panes: HashMap<String, State>,
}

impl Tracker {
    pub(super) fn update(
        &mut self,
        processes: &[DetectedAgent],
        activity: &[AgentActivity],
        hooks: &HookRuntime,
        identities: &HashMap<String, ProcessIdentity>,
    ) -> Vec<NfnSource> {
        let mut seen = HashSet::new();
        let mut completed = Vec::new();
        for process in processes {
            let pane = &process.0;
            // Scheduled jobs already have their own finish notifications.
            if process.6.is_some() {
                continue;
            }
            let Some(identity) = identities.get(pane) else {
                continue;
            };
            let Some(activity) = activity.iter().find(|item| &item.pane_id == pane) else {
                continue;
            };
            seen.insert(pane.clone());
            let hook = hooks.pane_state(pane, process.12);
            if self.observe(
                activity,
                identity,
                hook.as_ref(),
                idle_screen(&process.4, process.12),
            ) {
                completed.push(NfnSource {
                    pane_id: Some(pane.clone()),
                    session_id: hook.map(|hook| hook.session_id),
                    agent_pid: Some(identity.pid.clone()),
                    agent_started_at: identity.started_at,
                    group: process.5.clone(),
                    ..Default::default()
                });
            }
        }
        self.panes.retain(|pane, _| seen.contains(pane));
        completed
    }

    fn observe(
        &mut self,
        activity: &AgentActivity,
        process: &ProcessIdentity,
        hook: Option<&HookPaneState>,
        idle_screen: bool,
    ) -> bool {
        let session = hook.map(|hook| hook.session_id.clone());
        let working = activity.working
            || activity.asking
            || hook.is_some_and(|hook| hook.state == HookAgentState::Waiting);
        let failed = activity.alert.is_some();
        let recovered = hook.is_some_and(|hook| hook.event.starts_with("reconciled_"));
        let hook_at = hook.map_or(0, |hook| hook.updated_at_ms);
        let previous = self
            .panes
            .get(&activity.pane_id)
            .filter(|previous| previous.process == *process && previous.session == session);
        let completed = previous.is_some_and(|previous| {
            if working || failed || previous.failed || recovered {
                return false;
            }
            let finished = hook.map_or(idle_screen, |hook| {
                hook.state == HookAgentState::Idle
                    && matches!(
                        hook.event.as_str(),
                        "stop" | "session.idle" | "session.status" | "on_session_end"
                    )
                    && hook_at > previous.hook_at
            });
            // A short turn can start and finish between polls. Its completion
            // hook and a new action distinguish it from an idle housekeeping stop.
            let short_turn = hook.is_some()
                && activity.last_action_at_ms.is_some()
                && activity.last_action_at_ms > previous.action_at;
            finished && (previous.active || short_turn)
        });
        let active = !recovered
            && !failed
            && !completed
            && (working || previous.is_some_and(|previous| previous.active));
        let failed = failed || (!working && previous.is_some_and(|previous| previous.failed));
        self.panes.insert(
            activity.pane_id.clone(),
            State {
                process: process.clone(),
                session,
                active,
                failed,
                hook_at,
                action_at: activity.last_action_at_ms,
            },
        );
        completed
    }
}

fn idle_screen(screen: &str, provider: ProcessProvider) -> bool {
    match provider {
        ProcessProvider::Claude => claude_working_status(screen) == Some(false),
        // Codex can briefly hide its working indicator during an active turn.
        // Its composer remains visible throughout; require a completion hook.
        ProcessProvider::Codex => false,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(pid: &str) -> ProcessIdentity {
        ProcessIdentity {
            pid: pid.into(),
            started_at: Some(1),
        }
    }

    fn hook(event: &str, state: HookAgentState, at: u64) -> HookPaneState {
        HookPaneState {
            event: event.into(),
            session_id: "conversation".into(),
            state,
            attention: None,
            updated_at_ms: at,
        }
    }

    fn activity(working: bool, asking: bool, at: u64) -> AgentActivity {
        AgentActivity {
            pane_id: "%1".into(),
            last_action_at_ms: Some(at),
            working,
            asking,
            alert: None,
        }
    }

    #[test]
    fn recovered_status_does_not_report_completion_or_leave_an_active_turn() {
        for recovered in [
            "reconciled_idle",
            "reconciled_complete",
            "reconciled_interrupted",
            "reconciled_failed",
        ] {
            let mut tracker = Tracker::default();
            let process = identity("10");
            let busy = hook("user_prompt_submit", HookAgentState::Working, 1);
            assert!(!tracker.observe(&activity(true, false, 1), &process, Some(&busy), false));
            let repair = hook(recovered, HookAgentState::Idle, 2);
            assert!(!tracker.observe(&activity(false, false, 2), &process, Some(&repair), true));
            let housekeeping = hook("stop", HookAgentState::Idle, 3);
            assert!(!tracker.observe(
                &activity(false, false, 2),
                &process,
                Some(&housekeeping),
                true
            ));
            let new_turn = hook("user_prompt_submit", HookAgentState::Working, 4);
            assert!(!tracker.observe(&activity(true, false, 4), &process, Some(&new_turn), false));
            let done = hook("stop", HookAgentState::Idle, 5);
            assert!(tracker.observe(&activity(false, false, 5), &process, Some(&done), true));
        }
    }

    #[test]
    fn one_completion_per_turn_and_no_replay_on_startup() {
        let mut tracker = Tracker::default();
        let process = identity("10");
        let idle = hook("stop", HookAgentState::Idle, 1);
        assert!(!tracker.observe(&activity(false, false, 1), &process, Some(&idle), true));
        let busy = hook("user_prompt_submit", HookAgentState::Working, 2);
        assert!(!tracker.observe(&activity(true, false, 2), &process, Some(&busy), false));
        let done = hook("stop", HookAgentState::Idle, 3);
        assert!(tracker.observe(&activity(false, false, 3), &process, Some(&done), true));
        assert!(!tracker.observe(&activity(false, false, 3), &process, Some(&done), true));
        let housekeeping = hook("stop", HookAgentState::Idle, 4);
        assert!(!tracker.observe(
            &activity(false, false, 3),
            &process,
            Some(&housekeeping),
            true
        ));
        let short_turn = hook("stop", HookAgentState::Idle, 6);
        assert!(tracker.observe(
            &activity(false, false, 6),
            &process,
            Some(&short_turn),
            true
        ));
        assert!(!Tracker::default().observe(
            &activity(false, false, 6),
            &process,
            Some(&short_turn),
            true
        ));
    }

    #[test]
    fn permission_waits_and_idle_reminders_are_not_completions() {
        let mut tracker = Tracker::default();
        let process = identity("10");
        let busy = hook("pre_invocation", HookAgentState::Working, 1);
        tracker.observe(&activity(true, false, 1), &process, Some(&busy), false);
        let waiting = hook("permission_request", HookAgentState::Waiting, 2);
        for asking in [true, false] {
            assert!(!tracker.observe(&activity(false, asking, 2), &process, Some(&waiting), true));
        }
        let reminder = hook("notification", HookAgentState::Idle, 3);
        assert!(!tracker.observe(&activity(false, false, 2), &process, Some(&reminder), true));
        let done = hook("stop", HookAgentState::Idle, 4);
        assert!(tracker.observe(&activity(false, false, 4), &process, Some(&done), true));
    }

    #[test]
    fn failures_and_replaced_sessions_do_not_report_completion() {
        let mut tracker = Tracker::default();
        let process = identity("10");
        tracker.observe(&activity(true, false, 1), &process, None, false);
        let mut error = activity(false, false, 2);
        error.alert = Some("Connection failed".into());
        assert!(!tracker.observe(&error, &process, None, true));
        assert!(!tracker.observe(&activity(false, false, 3), &process, None, true));
        tracker.observe(&activity(true, false, 4), &process, None, false);
        assert!(tracker.observe(&activity(false, false, 5), &process, None, true));
        tracker.observe(&activity(true, false, 6), &process, None, false);
        assert!(!tracker.observe(&activity(false, false, 7), &identity("11"), None, true));

        let busy = hook("pre_invocation", HookAgentState::Working, 8);
        tracker.observe(&activity(true, false, 8), &process, Some(&busy), false);
        let mut replaced = hook("stop", HookAgentState::Idle, 9);
        replaced.session_id = "replacement".into();
        assert!(!tracker.observe(&activity(false, false, 9), &process, Some(&replaced), true));
    }

    #[test]
    fn codex_without_completion_hooks_never_finishes_from_screen_changes() {
        let mut tracker = Tracker::default();
        let process = identity("59819");
        tracker.observe(&activity(true, false, 1), &process, None, false);

        // The newsletter agent still had an active turn when its spinner vanished.
        for (index, screen) in [
            "OpenAI Codex\n\n\u{203a} Ask Codex to do anything",
            "Reading newsletter\n\n\u{203a} Ask Codex to do anything",
            "Done\n\n\u{203a} Ask Codex to do anything",
        ]
        .iter()
        .enumerate()
        {
            assert!(!tracker.observe(
                &activity(false, false, index as u64 + 2),
                &process,
                None,
                idle_screen(screen, ProcessProvider::Codex),
            ));
        }
    }

    #[test]
    fn fallback_requires_an_idle_composer_and_drops_exited_or_job_panes() {
        let mut tracker = Tracker::default();
        let mut process: DetectedAgent = (
            "%1".into(),
            "/repo".into(),
            "project".into(),
            "agent".into(),
            "working".into(),
            None,
            None,
            String::new(),
            String::new(),
            0,
            80,
            24,
            ProcessProvider::Claude,
            false,
        );
        let hooks = HookRuntime::default();
        let identities = HashMap::from([("%1".into(), identity("10"))]);
        assert!(tracker
            .update(
                &[process.clone()],
                &[activity(true, false, 1)],
                &hooks,
                &identities
            )
            .is_empty());
        assert!(tracker
            .update(
                &[process.clone()],
                &[activity(false, false, 2)],
                &hooks,
                &identities
            )
            .is_empty());
        process.4 = "Done\n\n\u{2500}\u{2500}\u{2500}\n\u{276f} \n\u{2500}\u{2500}\u{2500}".into();
        let completed = tracker.update(
            &[process.clone()],
            &[activity(false, false, 3)],
            &hooks,
            &identities,
        );
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].agent_pid.as_deref(), Some("10"));
        tracker.update(
            &[process.clone()],
            &[activity(true, false, 4)],
            &hooks,
            &identities,
        );
        assert!(tracker.update(&[], &[], &hooks, &identities).is_empty());
        assert!(tracker
            .update(
                &[process.clone()],
                &[activity(false, false, 5)],
                &hooks,
                &identities
            )
            .is_empty());
        process.6 = Some("scheduled/job".into());
        assert!(tracker
            .update(
                &[process.clone()],
                &[activity(true, false, 6)],
                &hooks,
                &identities
            )
            .is_empty());
        assert!(tracker
            .update(
                &[process],
                &[activity(false, false, 7)],
                &hooks,
                &identities
            )
            .is_empty());
    }
}
