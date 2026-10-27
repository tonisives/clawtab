use clawtab_lib::managed::{self, Client, Request, Response, SessionInfo, Size, Snapshot, Status};
use std::{
    io::{BufRead, Read, Write},
    process::Command,
    time::{Duration, Instant},
};

#[test]
fn local_transport_round_trip_and_disconnect() {
    let path = clawtab_lib::runtime_paths::ensure()
        .unwrap()
        .join(format!("test-{}.sock", uuid::Uuid::new_v4()));
    let listener = clawtab_lib::local_transport::listen(&path).unwrap();
    let server = std::thread::spawn(move || {
        let mut stream = clawtab_lib::local_transport::accept(&listener).unwrap();
        let mut message = [0; 4];
        stream.read_exact(&mut message).unwrap();
        assert_eq!(&message, b"ping");
        std::thread::sleep(Duration::from_millis(50));
        stream.write_all(b"pong").unwrap();
        // Closing the client must unblock the owner connection reader.
        assert!(matches!(stream.read(&mut message), Ok(0) | Err(_)));
    });
    let mut client = clawtab_lib::local_transport::connect(&path).unwrap();
    #[cfg(windows)]
    assert_eq!(client.server_process_id().unwrap(), std::process::id());
    client.write_all(b"ping").unwrap();
    let mut response = [0; 4];
    client.read_exact(&mut response).unwrap();
    assert_eq!(&response, b"pong");
    drop(client);
    server.join().unwrap();
    #[cfg(unix)]
    std::fs::remove_file(path).unwrap();
}

#[test]
fn securing_a_directory_preserves_access_to_existing_children() {
    let directory = tempfile::tempdir().unwrap();
    let existing = directory.path().join("existing.txt");
    std::fs::write(&existing, "existing content").unwrap();
    clawtab_lib::local_transport::private_directory(directory.path()).unwrap();
    assert_eq!(
        std::fs::read_to_string(existing).unwrap(),
        "existing content"
    );
    let created = directory.path().join("created.txt");
    std::fs::write(&created, "new content").unwrap();
    assert_eq!(std::fs::read_to_string(created).unwrap(), "new content");
}

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
        if line == "fail" {
            std::process::exit(7);
        }
        if line == "size" {
            let (cols, rows) = crossterm::terminal::size().unwrap();
            println!("SIZE={cols}x{rows}");
        } else if line == "flood" {
            for index in 0..4000 {
                println!("OUTPUT {index}: abcdefghijklmnopqrstuvwxyz0123456789");
            }
            println!("FLOOD_DONE");
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

#[cfg(windows)]
#[test]
fn windows_batch_shim_launches_with_spaced_arguments() {
    let directory = tempfile::tempdir().unwrap();
    let batch = directory.path().join("agent shim.cmd");
    std::fs::write(
        &batch,
        "@echo off\r\necho BATCH_READY:%~1\r\nset /p input=\r\n",
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_cwtctl"))
        .env("CLAWTAB_SESSION_DIR", directory.path())
        .args(["session", "start", "--detached", "--keep-running", "--"])
        .arg(&batch)
        .arg("argument with spaces")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let id = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let mut client = managed::connect(&id).unwrap();
    let Response::Info { session: info } = client.request(Request::Info).unwrap() else {
        panic!("no info");
    };
    let session = Session { directory, info };
    wait_for(|| {
        let screen = match client.request(Request::Snapshot { after: None }) {
            Ok(Response::Snapshot { snapshot }) => snapshot,
            _ => serde_json::from_slice::<Snapshot>(
                &std::fs::read(
                    session
                        .directory
                        .path()
                        .join(session.info.id.strip_prefix("managed:").unwrap())
                        .join("screen.json"),
                )
                .unwrap(),
            )
            .unwrap(),
        };
        assert_eq!(
            screen.status,
            Status::Running,
            "batch output: {}",
            screen.text
        );
        screen.text.contains("BATCH_READY:argument with spaces")
    });
}

struct Session {
    directory: tempfile::TempDir,
    info: SessionInfo,
}
impl Session {
    fn with_close_policy() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let id = format!("managed:{}", uuid::Uuid::new_v4());
        let launch = managed::Launch {
            program: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            args: vec![
                "--exact".into(),
                "terminal_fixture".into(),
                "--nocapture".into(),
                "--test-threads=1".into(),
            ],
            cwd: directory.path().to_string_lossy().into_owned(),
            size: Size::default(),
            close_with_terminal: true,
            provider: "shell".into(),
            conversation_id: None,
            metadata: Default::default(),
        };
        let mut owner = Command::new(env!("CARGO_BIN_EXE_cwtctl"))
            .env("CLAWTAB_SESSION_DIR", directory.path())
            .env("CLAWTAB_TERMINAL_FIXTURE", "1")
            .args(["session", "_serve", &id])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let bytes = serde_json::to_vec(&launch).unwrap();
        let mut input = owner.stdin.take().unwrap();
        input
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        input.write_all(&bytes).unwrap();
        drop(input);
        let mut info = None;
        wait_for(|| {
            assert!(owner.try_wait().unwrap().is_none(), "owner failed to start");
            if let Ok(mut client) = managed::connect(&id) {
                if let Ok(Response::Info { session }) = client.request(Request::Info) {
                    info = Some(session);
                    return true;
                }
            }
            false
        });
        // Reap the owner without tying its lifetime to the test viewer.
        std::thread::spawn(move || {
            let _ = owner.wait();
        });
        Self {
            directory,
            info: info.unwrap(),
        }
    }
    fn start() -> Self {
        let directory = tempfile::tempdir().unwrap();
        eprintln!("starting detached fixture");
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
        eprintln!("detached launcher returned; listing sessions");
        let sessions = Command::new(env!("CARGO_BIN_EXE_cwtctl"))
            .env("CLAWTAB_SESSION_DIR", directory.path())
            .args(["session", "list", "--json"])
            .output()
            .unwrap();
        let mut sessions: Vec<SessionInfo> = serde_json::from_slice(&sessions.stdout).unwrap();
        assert_eq!(sessions.len(), 1);
        eprintln!("session registered");
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

#[test]
fn close_policy_stops_only_on_origin_loss_and_explicit_detach_keeps_running() {
    let session = Session::with_close_policy();
    let mut origin = session.connect();
    origin
        .request(Request::Attach {
            viewer: "origin".into(),
            size: Size::default(),
            origin: true,
        })
        .unwrap();
    let mut viewer = session.connect();
    viewer
        .request(Request::Attach {
            viewer: "extra".into(),
            size: Size::default(),
            origin: false,
        })
        .unwrap();
    drop(viewer);
    assert_eq!(snapshot(&mut origin).status, Status::Running);
    drop(origin);
    wait_for(|| session.saved().status == Status::Exited);
    assert_eq!(session.saved().exit_code, Some(0));

    let detached = Session::with_close_policy();
    let mut origin = detached.connect();
    origin
        .request(Request::Attach {
            viewer: "origin".into(),
            size: Size::default(),
            origin: true,
        })
        .unwrap();
    origin.request(Request::Detach).unwrap();
    drop(origin);
    let mut viewer = detached.connect();
    assert_eq!(snapshot(&mut viewer).status, Status::Running);
    viewer.request(Request::Stop).unwrap();
    wait_for(|| detached.saved().status == Status::Exited);
    assert_eq!(detached.saved().exit_code, Some(0));
}

#[test]
fn command_failure_preserves_its_exit_code() {
    let session = Session::start();
    let mut client = session.connect();
    wait_for(|| snapshot(&mut client).text.contains("FIXTURE_READY"));
    client
        .request(Request::AutomationInput {
            data: b"fail\r".to_vec(),
        })
        .unwrap();
    wait_for(|| session.saved().status == Status::Exited);
    assert_eq!(session.saved().exit_code, Some(7));
}

#[test]
fn owner_crash_is_interrupted_without_relaunching_the_command() {
    let session = Session::start();
    #[cfg(unix)]
    assert_eq!(
        unsafe { libc::kill(session.info.owner_pid as i32, libc::SIGKILL) },
        0
    );
    #[cfg(windows)]
    assert!(Command::new("taskkill.exe")
        .args(["/PID", &session.info.owner_pid.to_string(), "/F"])
        .output()
        .unwrap()
        .status
        .success());
    wait_for(|| managed::connect(&session.info.id).is_err());
    let output = Command::new(env!("CARGO_BIN_EXE_cwtctl"))
        .env("CLAWTAB_SESSION_DIR", session.directory.path())
        .args(["session", "list", "--json"])
        .output()
        .unwrap();
    let sessions: Vec<SessionInfo> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(sessions[0].status, Status::Interrupted);
    assert_eq!(sessions[0].execution_id, session.info.execution_id);
    let resume = Command::new(env!("CARGO_BIN_EXE_cwtctl"))
        .env("CLAWTAB_SESSION_DIR", session.directory.path())
        .args(["session", "resume", &session.info.id])
        .output()
        .unwrap();
    assert!(!resume.status.success());
    assert!(String::from_utf8_lossy(&resume.stderr).contains("no saved provider conversation"));
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
    eprintln!("attaching local viewer");
    let mut local = session.connect();
    local
        .request(Request::Attach {
            viewer: "desktop".into(),
            size: Size::new(100, 30),
            origin: true,
        })
        .unwrap();
    wait_for(|| snapshot(&mut local).text.contains("FIXTURE_READY"));
    eprintln!("fixture output received; taking remote control");
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
            data: b"flood\r".to_vec(),
        })
        .unwrap();
    for cols in [42, 38, 46, 40] {
        remote
            .request(Request::RemoteResize {
                holder: "phone".into(),
                epoch: control.epoch,
                size: Size::new(cols, 20),
            })
            .unwrap();
    }
    wait_for(|| snapshot(&mut remote).text.contains("FLOOD_DONE"));
    remote
        .request(Request::RemoteInput {
            holder: "phone".into(),
            epoch: control.epoch,
            data: b"size\r".to_vec(),
        })
        .unwrap();
    wait_for(|| snapshot(&mut remote).text.contains("SIZE=40x20"));
    eprintln!("remote resize verified; reclaiming local control");
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
    eprintln!("local reclaim verified; reconnecting host");
    // Dropping the host's connection restores desktop control without stopping.
    remote
        .request(Request::TakeControl {
            holder: "phone".into(),
            size: Size::new(36, 18),
        })
        .unwrap();
    drop(remote);
    wait_for(|| snapshot(&mut local).control.holder.is_none());
    eprintln!("host disconnect reclaimed control");
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
    eprintln!("waiting for agent exit");
    wait_for(|| session.saved().status == Status::Exited);
    assert_eq!(session.saved().exit_code, Some(0));
}
