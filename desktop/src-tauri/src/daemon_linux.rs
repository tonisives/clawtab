use std::{path::PathBuf, process::Command};
pub fn unit_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("home directory unavailable")?
        .join(".config/systemd/user/clawtab.service"))
}
pub fn is_installed() -> bool {
    unit_path().is_ok_and(|p| p.exists())
}
pub fn is_running() -> (bool, Option<u32>) {
    let output = Command::new("systemctl")
        .args([
            "--user",
            "show",
            "clawtab.service",
            "--property=MainPID",
            "--value",
        ])
        .output();
    let pid = output
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<u32>()
                .ok()
        })
        .filter(|p| *p != 0);
    (pid.is_some(), pid)
}
fn systemctl(args: &[&str]) -> Result<String, String> {
    let status = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("systemctl failed; verify the user systemd manager is running".into());
    }
    Ok("Daemon service updated".into())
}
fn quoted(value: &str) -> Result<String, String> {
    if value.contains(['\n', '\r', '\0']) {
        return Err("invalid service path".into());
    }
    Ok(format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    ))
}
pub fn install() -> Result<String, String> {
    let binary = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("clawtab-daemon");
    if !binary.is_file() {
        return Err("clawtab-daemon must be installed beside cwtctl".into());
    }
    let path = unit_path()?;
    let parent = path.parent().ok_or("invalid service path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let executable = quoted(&binary.to_string_lossy())?;
    let search_path = quoted(&format!(
        "PATH={}",
        std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into())
    ))?;
    let unit=format!("[Unit]\nDescription=ClawTab agent host\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart={executable}\nEnvironment={search_path}\nEnvironment=LANG=C.UTF-8\nRestart=on-failure\nRestartSec=3\nKillMode=process\nUMask=0077\n\n[Install]\nWantedBy=default.target\n");
    std::fs::write(path, unit).map_err(|e| e.to_string())?;
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", "--now", "clawtab.service"])
}
pub fn restart() -> Result<String, String> {
    systemctl(&["restart", "clawtab.service"])
}
pub fn stop() -> Result<String, String> {
    systemctl(&["stop", "clawtab.service"])
}
pub fn uninstall() -> Result<String, String> {
    systemctl(&["disable", "--now", "clawtab.service"])?;
    std::fs::remove_file(unit_path()?).map_err(|e| e.to_string())?;
    systemctl(&["daemon-reload"])
}
pub fn logs() -> Result<(), String> {
    Command::new("journalctl")
        .args(["--user", "-u", "clawtab.service", "-n", "50", "--no-pager"])
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}
