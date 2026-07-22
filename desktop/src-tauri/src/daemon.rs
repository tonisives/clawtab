use std::fs::OpenOptions;
use std::io::{BufRead, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::ipc::{self, IpcCommand, IpcResponse};

pub const PLIST_LABEL: &str = "com.clawtab.daemon";
pub const ENGINE_EXECUTABLE_PATH: &str = "/usr/local/bin/clawtab-daemon";
pub const DAEMON_LOCK_PATH: &str = "/tmp/clawtab/daemon.lock";

pub const PLIST_CONTENT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clawtab.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/clawtab-daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/clawtab/daemon.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/clawtab/daemon.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>RUST_LOG</key>
        <string>info</string>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
        <key>LC_ALL</key>
        <string>en_US.UTF-8</string>
    </dict>
</dict>
</plist>"#;

pub fn plist_dest() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", PLIST_LABEL))
}

pub fn is_installed() -> bool {
    plist_dest().exists()
}

fn ping_daemon_socket() -> Result<bool, std::io::ErrorKind> {
    let mut stream = std::os::unix::net::UnixStream::connect(ipc::daemon_socket_path())
        .map_err(|error| error.kind())?;

    let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(750)));

    let cmd = match serde_json::to_string(&IpcCommand::Ping) {
        Ok(cmd) => cmd,
        Err(_) => return Ok(false),
    };

    stream
        .write_all(cmd.as_bytes())
        .map_err(|error| error.kind())?;
    stream.write_all(b"\n").map_err(|error| error.kind())?;
    stream.flush().map_err(|error| error.kind())?;

    let mut reader = std::io::BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|error| error.kind())?;

    Ok(matches!(
        serde_json::from_str::<IpcResponse>(line.trim()),
        Ok(IpcResponse::Pong)
    ))
}

fn locked_daemon_pid_at(path: &Path) -> Option<u32> {
    let file = OpenOptions::new().read(true).open(path).ok()?;
    let lock_result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) };

    if lock_result == 0 {
        return None;
    }

    let error = std::io::Error::last_os_error();
    if error.raw_os_error() != Some(libc::EWOULDBLOCK) && error.raw_os_error() != Some(libc::EAGAIN)
    {
        return None;
    }

    let mut pid = String::new();
    std::io::BufReader::new(file).read_line(&mut pid).ok()?;
    pid.trim().parse::<u32>().ok()
}

fn locked_daemon_pid() -> Option<u32> {
    locked_daemon_pid_at(Path::new(DAEMON_LOCK_PATH))
}

fn daemon_is_running(
    socket_probe: Result<bool, std::io::ErrorKind>,
    fallback_pid: Option<u32>,
) -> bool {
    match socket_probe {
        Ok(responsive) => responsive,
        Err(std::io::ErrorKind::PermissionDenied) => fallback_pid.is_some(),
        Err(_) => false,
    }
}

fn launchctl_pid() -> Option<u32> {
    let output = std::process::Command::new("launchctl")
        .args(["list"])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().find(|line| line.contains(PLIST_LABEL))?;
    let pid_str = line.split_whitespace().next().unwrap_or("-");
    if pid_str == "-" {
        None
    } else {
        pid_str.parse::<u32>().ok()
    }
}

/// Check if the daemon is running. Returns (running, pid).
///
/// The socket ping is authoritative unless sandboxing denies access to the
/// socket. In that case, fall back to launchd or the daemon's held lock. A
/// stale lock file is ignored because it no longer has a kernel lock.
pub fn is_running() -> (bool, Option<u32>) {
    let socket_probe = ping_daemon_socket();
    let pid = launchctl_pid().or_else(locked_daemon_pid);
    (daemon_is_running(socket_probe, pid), pid)
}

pub fn install() -> Result<String, String> {
    let dest = plist_dest();
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let _ = std::fs::create_dir_all("/tmp/clawtab");

    if !std::path::Path::new(ENGINE_EXECUTABLE_PATH).exists() {
        return Err(
            "clawtab-daemon not found. Run 'make daemon-build && make daemon-copy-local' first."
                .into(),
        );
    }

    std::fs::write(&dest, PLIST_CONTENT).map_err(|e| format!("Failed to write plist: {}", e))?;

    let status = std::process::Command::new("launchctl")
        .args(["load", &dest.display().to_string()])
        .status()
        .map_err(|e| format!("Failed to run launchctl: {}", e))?;

    if status.success() {
        Ok("Daemon installed and started".into())
    } else {
        Err(format!("launchctl load exited with {}", status))
    }
}

pub fn restart() -> Result<String, String> {
    let dest = plist_dest();
    if !dest.exists() {
        return Err("Daemon is not installed".into());
    }

    let dest_str = dest.display().to_string();

    let _ = std::process::Command::new("launchctl")
        .args(["unload", &dest_str])
        .status();

    let status = std::process::Command::new("launchctl")
        .args(["load", &dest_str])
        .status()
        .map_err(|e| format!("Failed to run launchctl: {}", e))?;

    if status.success() {
        Ok("Daemon restarted".into())
    } else {
        Err(format!("launchctl load exited with {}", status))
    }
}

/// Stop the loaded launchd service without removing its plist.
pub fn stop() -> Result<String, String> {
    let dest = plist_dest();
    if !dest.exists() {
        return Err("Daemon is not installed".into());
    }

    let status = std::process::Command::new("launchctl")
        .args(["unload", &dest.display().to_string()])
        .status()
        .map_err(|e| format!("Failed to run launchctl: {}", e))?;

    if status.success() {
        Ok("Daemon stopped".into())
    } else {
        Err(format!("launchctl unload exited with {}", status))
    }
}

pub fn uninstall() -> Result<String, String> {
    let dest = plist_dest();
    if !dest.exists() {
        return Err("Daemon is not installed".into());
    }

    let _ = std::process::Command::new("launchctl")
        .args(["unload", &dest.display().to_string()])
        .status();

    std::fs::remove_file(&dest).map_err(|e| format!("Failed to remove plist: {}", e))?;

    Ok("Daemon uninstalled".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn held_daemon_lock_reports_its_pid() {
        let directory = tempfile::tempdir().expect("tempdir");
        let lock_path = directory.path().join("daemon.lock");
        let mut lock_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&lock_path)
            .expect("open lock file");
        writeln!(lock_file, "42").expect("write pid");

        let lock_result =
            unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_eq!(lock_result, 0);
        assert_eq!(locked_daemon_pid_at(&lock_path), Some(42));
    }

    #[test]
    fn stale_daemon_lock_is_ignored() {
        let directory = tempfile::tempdir().expect("tempdir");
        let lock_path = directory.path().join("daemon.lock");
        std::fs::write(&lock_path, "42\n").expect("write stale lock");

        assert_eq!(locked_daemon_pid_at(&lock_path), None);
    }

    #[test]
    fn permission_denied_uses_validated_fallback_pid() {
        assert!(daemon_is_running(
            Err(std::io::ErrorKind::PermissionDenied),
            Some(42)
        ));
        assert!(!daemon_is_running(
            Err(std::io::ErrorKind::PermissionDenied),
            None
        ));
    }

    #[test]
    fn other_socket_failures_do_not_use_fallback_pid() {
        assert!(!daemon_is_running(
            Err(std::io::ErrorKind::ConnectionRefused),
            Some(42)
        ));
        assert!(!daemon_is_running(Ok(false), Some(42)));
        assert!(daemon_is_running(Ok(true), None));
    }
}
