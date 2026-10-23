//! Opt-in integration against real Hermes and the loopback model fixture.
//! See docs/hermes.md for the isolated runner.
use super::*;
use crate::agent_session::resolve_session_info;
use crate::pty::{OutputSink, PtyManager};
use std::process::Command;

fn tmux(args: &[&str]) -> String {
    let output = Command::new("tmux").args(args).output().unwrap();
    assert!(
        output.status.success(),
        "tmux failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

async fn until<T>(description: &str, mut check: impl FnMut() -> Option<T>) -> T {
    let started = Instant::now();
    loop {
        if let Some(value) = check() {
            return value;
        }
        assert!(
            started.elapsed() < Duration::from_secs(45),
            "timed out: {description}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn session(pane: &str) -> crate::agent_session::SessionInfo {
    let pid = tmux(&["display-message", "-p", "-t", pane, "#{pane_pid}"]);
    resolve_session_info(&pid)
}

fn processes(hooks: &HookRuntime) -> Vec<DetectedAgent> {
    detect_question_processes(
        &Arc::new(Mutex::new(JobsConfig::default())),
        &Arc::new(Mutex::new(HashMap::new())),
        hooks,
        &ProcessSnapshot::capture(),
    )
    .processes
}

async fn state(hooks: &HookRuntime, pane: &str, expected: HookAgentState) {
    until(&format!("{pane} state {expected:?}"), || {
        processes(hooks);
        hooks
            .pane_state(pane, ProcessProvider::Hermes)
            .filter(|state| state.state == expected)
    })
    .await;
}

async fn question(hooks: &HookRuntime, pane: &str) -> ClaudeQuestion {
    until("Hermes question card", || {
        let mut cache = HashMap::new();
        update_question_cache_with_hooks(&processes(hooks), &mut cache, hooks);
        cache.remove(pane).map(|entry| entry.question)
    })
    .await
}

struct Live {
    pty: PtyManager,
    panes: [String; 2],
    watcher: tokio::task::JoinHandle<()>,
}

impl Drop for Live {
    fn drop(&mut self) {
        for pane in &self.panes {
            let _ = self.pty.release(pane);
        }
        self.watcher.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires tests/hermes-integration.py and Hermes v0.22.4"]
async fn hermes_live_remote_workflow() {
    // The runner provides a private socket, hook spool and two disposable panes.
    let socket = std::env::var("CLAWTAB_HERMES_TEST_SOCKET").expect("use isolated Hermes runner");
    assert!(socket.starts_with("clawtab-hermes-test-"));
    assert!(tmux(&["display-message", "-p", "#{socket_path}"]).ends_with(&socket));
    let hook_dir = std::env::var("CLAWTAB_AGENT_HOOKS_DIR").unwrap();
    assert!(hook_dir.contains("clawtab-hermes-"));
    let panes = [
        std::env::var("CLAWTAB_HERMES_TEST_PANE_A").unwrap(),
        std::env::var("CLAWTAB_HERMES_TEST_PANE_B").unwrap(),
    ];
    let a = panes[0].clone();
    let b = panes[1].clone();
    let hooks = HookRuntime::default();
    let watcher = tokio::spawn(crate::agent_hooks::run_event_watcher(
        hooks.clone(),
        Arc::default(),
        Arc::default(),
        Arc::new(crate::events::NoopEventSink),
    ));
    let mut live = Live {
        pty: PtyManager::new(),
        panes,
        watcher,
    };
    let first = until("first session metadata", || {
        let info = session(&a);
        info.first_query.is_some().then_some(info)
    })
    .await;
    let second = until("second session metadata", || {
        let info = session(&b);
        info.first_query.is_some().then_some(info)
    })
    .await;
    assert_ne!(first.session_id, second.session_id);
    assert_eq!(first.first_query.as_deref(), Some("CLAWTAB_TEST_HELLO"));
    assert_eq!(second.first_query.as_deref(), Some("CLAWTAB_TEST_SECOND"));
    assert_eq!(first.model_id.as_deref(), Some("clawtab-test"));
    assert!(first.started_epoch.is_some());
    state(&hooks, &a, HookAgentState::Idle).await;
    state(&hooks, &b, HookAgentState::Idle).await;
    let remote = crate::process_snapshot::detect_processes_snapshot(
        &Arc::new(Mutex::new(JobsConfig::default())),
        &Arc::default(),
        &Arc::new(Mutex::new(PtyManager::new())),
    )
    .await;
    for pane in [&a, &b] {
        let process = remote
            .iter()
            .find(|process| &process.pane_id == pane)
            .unwrap();
        assert_eq!(process.provider, "hermes");
        assert_eq!(process.model_id.as_deref(), Some("clawtab-test"));
        assert!(process.first_query.is_some());
    }
    eprintln!("passed: distinct session metadata and lifecycle binding");

    let (tx, rx) = std::sync::mpsc::sync_channel(512);
    let output = Arc::new(Mutex::new(Vec::new()));
    let captured = output.clone();
    let expected_pane = a.clone();
    std::thread::spawn(move || {
        while let Ok((pane, bytes)) = rx.recv() {
            assert_eq!(pane, expected_pane);
            captured.lock().extend(bytes);
        }
    });
    live.pty
        .spawn(&a, "hermes-test", 100, 32, "test", OutputSink::Channel(tx))
        .unwrap();
    live.pty.resize(&a, 92, 28).unwrap();
    until("remote terminal resize", || {
        (tmux(&[
            "display-message",
            "-p",
            "-t",
            &a,
            "#{pane_width}x#{pane_height}",
        ]) == "92x28")
            .then_some(())
    })
    .await;
    live.pty.write(&a, b"CLAWTAB_TEST_SLOW").unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    live.pty.write(&a, b"\r").unwrap();
    state(&hooks, &a, HookAgentState::Working).await;
    assert_eq!(
        hooks.pane_state(&b, ProcessProvider::Hermes).unwrap().state,
        HookAgentState::Idle
    );
    state(&hooks, &a, HookAgentState::Idle).await;
    until("remote output stream", || {
        String::from_utf8_lossy(&output.lock())
            .contains("HERMES_SLOW_DONE")
            .then_some(())
    })
    .await;
    eprintln!("passed: remote PTY input, output, resize and working/idle isolation");

    crate::terminal_backend::send_keys_to_tui_pane(&a, "CLAWTAB_TEST_APPROVAL").unwrap();
    state(&hooks, &a, HookAgentState::Waiting).await;
    let q = question(&hooks, &a).await;
    assert_eq!(q.input_mode, "command");
    let once = q
        .options
        .iter()
        .find(|option| option.label == "Allow once")
        .unwrap();
    crate::terminal_backend::send_keys_to_tui_pane(&a, &once.number).unwrap();
    state(&hooks, &a, HookAgentState::Idle).await;
    assert!(question_cache_empty(&hooks, &a));
    crate::terminal_backend::send_keys_to_tui_pane(&a, "CLAWTAB_TEST_APPROVAL again").unwrap();
    state(&hooks, &a, HookAgentState::Waiting).await;
    let auto = question(&hooks, &a).await;
    assert_ne!(q.question_id, auto.question_id);
    let mut answered = HashMap::new();
    try_send_auto_answer(&auto, &mut answered);
    assert!(answered.contains_key(&auto.question_id));
    state(&hooks, &a, HookAgentState::Idle).await;
    eprintln!("passed: approval cards, manual reply, auto-yes and stale-card removal");

    crate::terminal_backend::send_keys_to_tui_pane(&a, "CLAWTAB_TEST_CLARIFY").unwrap();
    state(&hooks, &a, HookAgentState::Waiting).await;
    let q = question(&hooks, &a).await;
    assert!(find_yes_option(&q.options).is_none());
    let free = q
        .options
        .iter()
        .find(|option| option.label == "Type something")
        .unwrap();
    crate::terminal_backend::send_keys_to_tui_pane_freetext(&a, &free.number, "Blue").unwrap();
    state(&hooks, &a, HookAgentState::Idle).await;
    eprintln!("passed: clarification reply without auto-answer");

    crate::terminal_backend::send_keys_to_tui_pane(&b, "CLAWTAB_TEST_FOLLOWUP").unwrap();
    until("second session follow-up metadata", || {
        (session(&b).last_query.as_deref() == Some("CLAWTAB_TEST_FOLLOWUP")).then_some(())
    })
    .await;
    assert_eq!(
        session(&a).last_query.as_deref(),
        Some("CLAWTAB_TEST_CLARIFY")
    );
    live.pty.write(&a, b"CLAWTAB_TEST_SLOW").unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    live.pty.write(&a, b"\r").unwrap();
    state(&hooks, &a, HookAgentState::Working).await;
    live.pty.write(&a, b"\x03").unwrap();
    state(&hooks, &a, HookAgentState::Idle).await;
    crate::terminal_backend::send_keys_to_tui_pane(&a, "/new").unwrap();
    let confirm = until("new session confirmation", || {
        let screen = tmux(&["capture-pane", "-p", "-t", &a]);
        if screen.contains("Y/N quick") {
            Some("y")
        } else if screen.contains("Type 1/2/3") {
            Some("1")
        } else {
            None
        }
    })
    .await;
    crate::terminal_backend::send_literal_to_pane(&a, confirm).unwrap();
    // The new DB row is lazy, but the view publishes its new identity as soon
    // as /new completes. Wait for that boundary before entering another prompt.
    until("new session identity", || {
        let info = session(&a);
        (info.session_id.is_some() && info.session_id != first.session_id).then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    crate::terminal_backend::send_keys_to_tui_pane(&a, "CLAWTAB_TEST_HELLO new session").unwrap();
    until("new session rebinding", || {
        let info = session(&a);
        (info.session_id.is_some()
            && info.session_id != first.session_id
            && info.first_query.as_deref() == Some("CLAWTAB_TEST_HELLO new session"))
        .then_some(())
    })
    .await;
    state(&hooks, &a, HookAgentState::Idle).await;
    assert_eq!(session(&b).session_id, second.session_id);
    live.pty.release(&a).unwrap();
    let (tx, _rx) = std::sync::mpsc::sync_channel(512);
    live.pty
        .spawn(&a, "hermes-test", 110, 36, "test", OutputSink::Channel(tx))
        .unwrap();
    live.pty.release(&a).unwrap();
    eprintln!("passed: follow-up isolation, interruption, /new and PTY reconnect");

    let restore = format!(
        "export PATH={}; {} --cli; exec /bin/sh",
        format!(
            "'{}'",
            std::env::var("PATH").unwrap().replace('\'', "'\\''")
        ),
        first.restore_command.unwrap()
    );
    let restored = tmux(&[
        "new-window",
        "-d",
        "-t",
        "hermes-test",
        "-P",
        "-F",
        "#{pane_id}",
        &restore,
    ]);
    until("restore original conversation", || {
        let info = session(&restored);
        (info.session_id == first.session_id
            && info.first_query.as_deref() == Some("CLAWTAB_TEST_HELLO"))
        .then_some(())
    })
    .await;
    tmux(&["kill-pane", "-t", &restored]);
    let current = processes(&hooks);
    let live_panes = current.iter().map(|process| process.0.clone()).collect();
    hooks.retain_live_panes(&live_panes, &HashSet::new(), &live_panes);
    assert!(hooks
        .pane_state(&restored, ProcessProvider::Hermes)
        .is_none());
    eprintln!("passed: exact-profile resume and closed-pane cleanup");
}

fn question_cache_empty(hooks: &HookRuntime, pane: &str) -> bool {
    let mut cache = HashMap::new();
    update_question_cache_with_hooks(&processes(hooks), &mut cache, hooks);
    !cache.contains_key(pane)
}
