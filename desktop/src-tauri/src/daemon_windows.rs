use std::os::windows::process::CommandExt;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
};

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
fn binary() -> Result<PathBuf, String> {
    Ok(std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("clawtab-daemon.exe"))
}
pub fn is_installed() -> bool {
    Command::new("reg.exe")
        .args(["query", RUN_KEY, "/v", "ClawTab"])
        .output()
        .is_ok_and(|output| output.status.success())
}
pub fn is_running() -> (bool, Option<u32>) {
    let running = crate::local_transport::connect(&crate::ipc::daemon_socket_path()).is_ok();
    let pid = running
        .then(|| {
            std::fs::read_to_string(crate::runtime_paths::lock())
                .ok()?
                .trim()
                .parse()
                .ok()
        })
        .flatten();
    (running, pid)
}
pub fn install() -> Result<String, String> {
    let binary = binary()?;
    if !binary.is_file() {
        return Err("clawtab-daemon.exe must be installed beside cwtctl.exe".into());
    }
    let value = format!("\"{}\"", binary.display());
    let status = Command::new("reg.exe")
        .args([
            "add", RUN_KEY, "/v", "ClawTab", "/t", "REG_SZ", "/d", &value, "/f",
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Could not install per-user ClawTab startup".into());
    }
    start()?;
    Ok("ClawTab starts when you sign in to Windows".into())
}
fn start() -> Result<(), String> {
    if is_running().0 {
        return Ok(());
    }
    crate::runtime_paths::ensure()?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
        .map_err(|e| e.to_string())?;
    crate::local_transport::detach_standard_handles().map_err(|e| e.to_string())?;
    Command::new(binary()?)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .creation_flags(
            windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
                | windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP,
        )
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn stop() -> Result<String, String> {
    if let (true, Some(pid)) = is_running() {
        // Do not use /T: session owners must survive daemon updates.
        let status = Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/F"])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Could not stop the daemon".into());
        }
    }
    Ok("Daemon stopped; managed agents continue running".into())
}
pub fn restart() -> Result<String, String> {
    stop()?;
    start()?;
    Ok("Daemon restarted".into())
}
pub fn uninstall() -> Result<String, String> {
    stop()?;
    let status = Command::new("reg.exe")
        .args(["delete", RUN_KEY, "/v", "ClawTab", "/f"])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Could not remove ClawTab startup".into());
    }
    Ok("ClawTab startup removed".into())
}
pub fn log_path() -> PathBuf {
    crate::runtime_paths::directory().join("daemon.log")
}
pub fn logs() -> Result<(), String> {
    print!(
        "{}",
        std::fs::read_to_string(log_path()).map_err(|e| e.to_string())?
    );
    Ok(())
}
