use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

use crate::ipc::{self, IpcCommand, IpcResponse};

pub const PLIST_LABEL: &str = "com.clawtab.daemon";
pub const ENGINE_EXECUTABLE_PATH: &str = "/usr/local/bin/clawtab-daemon";

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

fn ping_daemon_socket() -> bool {
    let stream = std::os::unix::net::UnixStream::connect(ipc::daemon_socket_path());
    let mut stream = match stream {
        Ok(stream) => stream,
        Err(_) => return false,
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(750)));

    let cmd = match serde_json::to_string(&IpcCommand::Ping) {
        Ok(cmd) => cmd,
        Err(_) => return false,
    };

    if stream.write_all(cmd.as_bytes()).is_err()
        || stream.write_all(b"\n").is_err()
        || stream.flush().is_err()
    {
        return false;
    }

    let mut reader = std::io::BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return false;
    }

    matches!(
        serde_json::from_str::<IpcResponse>(line.trim()),
        Ok(IpcResponse::Pong)
    )
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

/// Check if the daemon is running via its IPC socket. Returns (running, pid).
pub fn is_running() -> (bool, Option<u32>) {
    (ping_daemon_socket(), launchctl_pid())
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
