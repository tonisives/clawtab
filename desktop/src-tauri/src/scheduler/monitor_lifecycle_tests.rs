use super::*;

#[test]
fn guarded_monitor_never_latches_startup_idle_or_query_failure() {
    for sample in [
        Ok(tmux::PaneProcessState::Running),
        Err("temporary inventory failure".into()),
        Ok(tmux::PaneProcessState::Running),
    ] {
        assert_eq!(guarded_completion(sample), None);
    }
    assert_eq!(
        guarded_completion(Ok(tmux::PaneProcessState::Exited(Some(7)))),
        Some(Some(7))
    );
    assert_eq!(
        guarded_completion(Ok(tmux::PaneProcessState::Missing)),
        Some(None)
    );
}

struct OwnedPane(String);

#[test]
fn guarded_success_requires_real_zero_exit_and_valid_result() {
    assert!(trigger_succeeded(true, Some(0), "valid"));
    for code in [None, Some(7), Some(137)] {
        assert!(!trigger_succeeded(true, code, "valid"));
    }
    for status in ["missing", "not_requested", "invalid_json", "unreadable"] {
        assert!(!trigger_succeeded(true, Some(0), status));
    }
    assert!(trigger_succeeded(false, Some(0), "not_requested"));
}

impl Drop for OwnedPane {
    fn drop(&mut self) {
        let _ = tmux::kill_pane(&self.0);
    }
}

/// Opt-in: creates and removes one test shell alongside an explicitly selected pane.
/// No daemon, agent, emulator, credentials, production history or policy state is used.
#[tokio::test]
#[ignore = "requires CLAWTAB_LIFECYCLE_TEST_PARENT_PANE and real local tmux"]
async fn real_guarded_poller_survives_shell_startup_and_preserves_failed_exit() {
    let policy = clawtab_protocol::JobPolicy::CrmSocialResearch;
    let manager = crate::resource_policy::ResourcePolicyManager::for_tests(Default::default());
    let mut lease = manager.try_acquire(policy).expect("in-memory test lease");
    lease.commit();
    let parent = std::env::var("CLAWTAB_LIFECYCLE_TEST_PARENT_PANE").expect("explicit parent pane");
    assert_eq!(
        tmux::pane_process_state(&parent),
        Ok(tmux::PaneProcessState::Running)
    );
    let output = std::process::Command::new("tmux")
        .args([
            "split-window",
            "-d",
            "-t",
            &parent,
            "-P",
            "-F",
            "#{pane_id}",
            "/bin/sh",
        ])
        .output()
        .expect("create test shell");
    assert!(output.status.success());
    let pane = OwnedPane(
        String::from_utf8(output.stdout)
            .expect("pane ID")
            .trim()
            .to_string(),
    );
    assert!(pane.0.starts_with('%') && pane.0 != parent);
    tmux::retain_exited_pane(&pane.0).expect("retain exact test pane");
    let poller = spawn_exit_poller(&pane.0);
    tokio::time::sleep(std::time::Duration::from_millis(2200)).await;
    assert!(
        !poller.exited.load(Ordering::Acquire),
        "startup shell is still alive"
    );
    let rejected = manager
        .try_acquire(policy)
        .err()
        .expect("second claim rejected during startup");
    assert!(rejected.message.contains("already running"));
    tmux::send_keys_to_pane("", &pane.0, "/bin/sleep 1; exit 7").expect("run test command");
    tokio::time::timeout(std::time::Duration::from_secs(6), async {
        while !poller.exited.load(Ordering::Acquire) {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("true process exit observed");
    assert_eq!(*poller.exit_code.lock(), Some(7));
    assert_eq!(
        tmux::pane_process_state(&pane.0),
        Ok(tmux::PaneProcessState::Exited(Some(7)))
    );
    assert!(
        tmux::capture_pane_full(&pane.0).is_ok(),
        "output survives exit"
    );
    assert!(manager
        .try_acquire(policy)
        .err()
        .expect("lease held through collection")
        .message
        .contains("already running"));
    poller.task.abort();
    drop(lease);
    assert!(manager
        .try_acquire(policy)
        .err()
        .expect("cooldown after completion")
        .message
        .contains("cooling down"));
}
