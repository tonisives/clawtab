use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AerospaceWorkspace {
    pub name: String,
}

pub fn is_available() -> bool {
    Command::new("aerospace")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn list_workspaces() -> Vec<AerospaceWorkspace> {
    let output = Command::new("aerospace")
        .args(["list-workspaces", "--all"])
        .output()
        .ok();

    let text = output
        .as_ref()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| AerospaceWorkspace {
            name: l.trim().to_string(),
        })
        .collect()
}

pub fn move_window_to_workspace(workspace: &str) -> Result<(), String> {
    let output = Command::new("aerospace")
        .args(["move-node-to-workspace", workspace])
        .output()
        .map_err(|e| format!("Failed to run aerospace: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("aerospace error: {}", stderr.trim()));
    }

    Ok(())
}
