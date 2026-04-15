use std::path::PathBuf;

pub const PLIST_LABEL: &str = "com.clawtab.daemon";

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

/// Check if the daemon is running via launchctl. Returns (running, pid).
pub fn is_running() -> (bool, Option<u32>) {
    let output = std::process::Command::new("launchctl")
        .args(["list"])
        .output();

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let found = stdout.lines().find(|l| l.contains(PLIST_LABEL));
            match found {
                Some(line) => {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    let pid_str = parts.first().unwrap_or(&"-");
                    if *pid_str == "-" {
                        (false, None)
                    } else {
                        let pid = pid_str.parse::<u32>().ok();
                        (true, pid)
                    }
                }
                None => (false, None),
            }
        }
        Err(_) => (false, None),
    }
}

pub fn install() -> Result<String, String> {
    let dest = plist_dest();
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let _ = std::fs::create_dir_all("/tmp/clawtab");

    if !std::path::Path::new("/usr/local/bin/clawtab-daemon").exists() {
        return Err("/usr/local/bin/clawtab-daemon not found. Run 'make build-daemon' first.".into());
    }

    std::fs::write(&dest, PLIST_CONTENT)
        .map_err(|e| format!("Failed to write plist: {}", e))?;

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

pub fn uninstall() -> Result<String, String> {
    let dest = plist_dest();
    if !dest.exists() {
        return Err("Daemon is not installed".into());
    }

    let _ = std::process::Command::new("launchctl")
        .args(["unload", &dest.display().to_string()])
        .status();

    std::fs::remove_file(&dest)
        .map_err(|e| format!("Failed to remove plist: {}", e))?;

    Ok("Daemon uninstalled".into())
}
