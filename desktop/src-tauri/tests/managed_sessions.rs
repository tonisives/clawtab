use clawtab_lib::managed::{self, Client, Request, Response, SessionInfo, Size, Snapshot, Status};
use std::{
    io::{BufRead, Write},
    process::Command,
    time::{Duration, Instant},
};

// Run inside a real PTY on every supported OS, without an agent account.
#[test]
fn terminal_fixture() {
    if std::env::var_os("CLAWTAB_TERMINAL_FIXTURE").is_none() {
        return;
    }
    println!("FIXTURE_READY");
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        if line == "quit" {
            break;
        }
        if line == "size" {
            let (cols, rows) = crossterm::terminal::size().unwrap();
            println!("SIZE={cols}x{rows}");
        } else if line == "alternate" {
            print!("\x1b[?1049h\x1b[2J\x1b[1;1HALTERNATE\x1b[31m 世界\x1b[0m");
        } else if line == "primary" {
            print!("\x1b[?1049l");
        } else {
            println!("RECEIVED:{line}");
        }
        std::io::stdout().flush().unwrap();
    }
}

struct Session {
    directory: tempfile::TempDir,
    info: SessionInfo,
}
impl Session {
    fn start() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_cwtctl"))
            .env("CLAWTAB_SESSION_DIR", directory.path())
            .env("CLAWTAB_TERMINAL_FIXTURE", "1")
            .args(["session", "start", "--detached", "--keep-running", "--"])
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "terminal_fixture",
                "--nocapture",
                "--test-threads=1",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let sessions = Command::new(env!("CARGO_BIN_EXE_cwtctl"))
            .env("CLAWTAB_SESSION_DIR", directory.path())
            .args(["session", "list", "--json"])
            .output()
            .unwrap();
        let mut sessions: Vec<SessionInfo> = serde_json::from_slice(&sessions.stdout).unwrap();
        assert_eq!(sessions.len(), 1);
        Self {
            directory,
            info: sessions.remove(0),
        }
    }
    fn connect(&self) -> Client {
        managed::connect(&self.info.id).unwrap()
    }
    fn saved(&self) -> SessionInfo {
        serde_json::from_slice(
            &std::fs::read(
                self.directory
                    .path()
                    .join(self.info.id.strip_prefix("managed:").unwrap())
                    .join("session.json"),
            )
            .unwrap(),
        )
        .unwrap()
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = managed::request(&self.info.id, Request::Stop);
    }
}
fn snapshot(client: &mut Client) -> Snapshot {
    match client.request(Request::Snapshot { after: None }).unwrap() {
        Response::Snapshot { snapshot } => snapshot,
        response => panic!("unexpected response {response:?}"),
    }
}
fn wait_for(mut predicate: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !predicate() {
        assert!(Instant::now() < until, "condition did not become true");
        std::thread::sleep(Duration::from_millis(30));
    }
}

#[test]
fn durable_terminal_control_resize_and_reconnect() {
    let session = Session::start();
    let mut local = session.connect();
    local
        .request(Request::Attach {
            viewer: "desktop".into(),
            size: Size::new(100, 30),
            origin: true,
        })
        .unwrap();
    wait_for(|| snapshot(&mut local).text.contains("FIXTURE_READY"));
    let mut remote = session.connect();
    remote.request(Request::Watch).unwrap();
    let Response::Control { control } = remote
        .request(Request::TakeControl {
            holder: "phone".into(),
            size: Size::new(40, 20),
        })
        .unwrap()
    else {
        panic!("no control");
    };
    assert_eq!(snapshot(&mut remote).size, Size::new(40, 20));
    remote
        .request(Request::RemoteInput {
            holder: "phone".into(),
            epoch: control.epoch,
            data: b"size\r".to_vec(),
        })
        .unwrap();
    wait_for(|| snapshot(&mut remote).text.contains("SIZE=40x20"));
    // A desktop layout change during mobile control is restored on reclaim.
    local
        .request(Request::LocalResize {
            size: Size::new(110, 32),
        })
        .unwrap();
    assert_eq!(snapshot(&mut remote).size, Size::new(40, 20));
    assert!(matches!(
        local
            .request(Request::LocalInput {
                data: b"DO_NOT_SEND\r".to_vec()
            })
            .unwrap(),
        Response::Reclaimed
    ));
    assert_eq!(snapshot(&mut remote).size, Size::new(110, 32));
    assert!(remote
        .request(Request::RemoteInput {
            holder: "phone".into(),
            epoch: control.epoch,
            data: b"STALE\r".to_vec()
        })
        .is_err());
    assert!(remote
        .request(Request::RemoteResize {
            holder: "phone".into(),
            epoch: control.epoch,
            size: Size::new(20, 10)
        })
        .is_err());
    local
        .request(Request::LocalInput {
            data: b"size\r".to_vec(),
        })
        .unwrap();
    wait_for(|| snapshot(&mut local).text.contains("SIZE=110x32"));
    assert!(!snapshot(&mut local).text.contains("DO_NOT_SEND"));
    assert!(!snapshot(&mut local).text.contains("STALE"));
    // Dropping the host's connection restores desktop control without stopping.
    remote
        .request(Request::TakeControl {
            holder: "phone".into(),
            size: Size::new(36, 18),
        })
        .unwrap();
    drop(remote);
    wait_for(|| snapshot(&mut local).control.holder.is_none());
    let execution = session.info.execution_id.clone();
    drop(local); // closing the originating terminal keeps the agent alive
    let mut reconnected = session.connect();
    let Response::Info { session: info } = reconnected.request(Request::Info).unwrap() else {
        panic!("no info");
    };
    assert_eq!(info.execution_id, execution);
    assert_eq!(info.child_pid, session.info.child_pid);
    reconnected
        .request(Request::AutomationInput {
            data: b"alternate\r".to_vec(),
        })
        .unwrap();
    wait_for(|| snapshot(&mut reconnected).text.contains("ALTERNATE"));
    drop(reconnected);
    let mut reconnected = session.connect();
    assert!(snapshot(&mut reconnected).text.contains("ALTERNATE"));
    reconnected
        .request(Request::AutomationInput {
            data: b"primary\rquit\r".to_vec(),
        })
        .unwrap();
    wait_for(|| session.saved().status == Status::Exited);
    assert_eq!(session.saved().exit_code, Some(0));
}
