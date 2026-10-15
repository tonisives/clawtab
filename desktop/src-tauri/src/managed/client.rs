use super::{store, Launch, Request, Response, SessionInfo, Status, PREFIX, PROTOCOL_VERSION};
use crate::local_transport;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_MESSAGE: usize = 32 * 1024 * 1024;

pub struct Client {
    stream: local_transport::Stream,
}

pub(super) fn write_message<T: serde::Serialize>(
    stream: &mut impl Write,
    message: &T,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_MESSAGE {
        return Err("session message too large".into());
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(&bytes))
        .and_then(|_| stream.flush())
        .map_err(|e| e.to_string())
}

pub(super) fn read_message<T: serde::de::DeserializeOwned>(
    stream: &mut impl Read,
) -> Result<T, String> {
    let mut size = [0; 4];
    stream.read_exact(&mut size).map_err(|e| e.to_string())?;
    let size = u32::from_be_bytes(size) as usize;
    if size > MAX_MESSAGE {
        return Err("session message too large".into());
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

impl Client {
    pub fn request(&mut self, request: Request) -> Result<Response, String> {
        write_message(&mut self.stream, &request)?;
        match read_message(&mut self.stream)? {
            Response::Error { message } => Err(message),
            response => Ok(response),
        }
    }
}

pub fn connect(id: &str) -> Result<Client, String> {
    let mut client = Client {
        stream: local_transport::connect(&store::endpoint(id)?).map_err(|e| e.to_string())?,
    };
    client.request(Request::Hello {
        version: PROTOCOL_VERSION,
    })?;
    Ok(client)
}

pub fn request(id: &str, request: Request) -> Result<Response, String> {
    match connect(id) {
        Ok(mut client) => client.request(request),
        Err(error) => match request {
            Request::Info => {
                let mut session = store::read_info(id)?;
                if session.status == Status::Running {
                    session.status = Status::Interrupted;
                }
                Ok(Response::Info { session })
            }
            Request::Snapshot { .. } => Ok(Response::Snapshot {
                snapshot: store::final_snapshot(id)?,
            }),
            Request::Capture {
                history,
                ansi,
                lines,
            } => {
                let content = if history {
                    store::read::<String>(&store::directory(id)?.join("history.json"))?
                } else {
                    let snapshot = store::final_snapshot(id)?;
                    if ansi {
                        snapshot.ansi
                    } else {
                        snapshot.text
                    }
                };
                let all = content.lines().collect::<Vec<_>>();
                Ok(Response::Capture {
                    content: all[all.len().saturating_sub(lines as usize)..].join("\n"),
                })
            }
            _ => Err(error),
        },
    }
}

pub fn list() -> Result<Vec<SessionInfo>, String> {
    let mut sessions = Vec::new();
    for entry in std::fs::read_dir(store::root()?)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
    {
        let id = format!("{PREFIX}{}", entry.file_name().to_string_lossy());
        if !super::is_managed(&id) {
            continue;
        }
        if let Ok(Response::Info { session }) = request(&id, Request::Info) {
            sessions.push(session);
        }
    }
    sessions.sort_by_key(|session| session.started_at);
    Ok(sessions)
}

pub fn launcher_path() -> Result<std::path::PathBuf, String> {
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    if current.file_stem().is_some_and(|name| name == "cwtctl") {
        return Ok(current);
    }
    let sibling = current.with_file_name(if cfg!(windows) {
        "cwtctl.exe"
    } else {
        "cwtctl"
    });
    if sibling.is_file() {
        return Ok(sibling);
    }
    which::which("cwtctl").map_err(|_| "cwtctl launcher is not installed alongside the host".into())
}

pub fn launch(launch: Launch, env: &[(String, String)]) -> Result<SessionInfo, String> {
    launch_with_id(
        launcher_path()?.as_path(),
        &format!("{PREFIX}{}", uuid::Uuid::new_v4()),
        launch,
        env,
    )
}

pub(super) fn launch_with_id(
    executable: &Path,
    id: &str,
    launch: Launch,
    env: &[(String, String)],
) -> Result<SessionInfo, String> {
    if launch.program.is_empty() || !Path::new(&launch.cwd).is_dir() {
        return Err("program and an existing working directory are required".into());
    }
    if connect(id).is_ok() {
        return Err("session is already running".into());
    }
    let directory = store::directory(id)?;
    local_transport::private_directory(&directory)?;
    let mut command = Command::new(executable);
    command
        .args(["session", "_serve", id])
        .envs(env.iter().map(|(key, value)| (key, value)));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        local_transport::detach_standard_handles().map_err(|e| e.to_string())?;
        command.creation_flags(
            windows_sys::Win32::System::Threading::DETACHED_PROCESS
                | windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP,
        );
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("launcher stdin unavailable")?;
    write_message(&mut stdin, &launch)?;
    drop(stdin);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let error = match connect(id) {
            Ok(mut client) => match client.request(Request::Info)? {
                Response::Info { session } => {
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                    return Ok(session);
                }
                _ => "unexpected owner response".into(),
            },
            Err(error) => error,
        };
        if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
            let message = store::read::<String>(&directory.join("error.json"))
                .unwrap_or_else(|_| format!("launcher exited: {exit}"));
            return Err(message);
        }
        if Instant::now() > deadline {
            let phase = store::read::<String>(&directory.join("startup.json"))
                .unwrap_or_else(|_| "connecting to owner".into());
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "launcher did not become ready while {phase}: {error}"
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
