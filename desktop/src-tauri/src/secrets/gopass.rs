use std::process::Command;

/// Stateless helper for interacting with the gopass store.
/// Secrets selected from gopass are stored into macOS Keychain, not cached here.
pub struct GopassBackend;

impl GopassBackend {
    pub fn is_available() -> bool {
        Command::new("gopass")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// List all entries in gopass store (flat list of paths)
    pub fn list_entries() -> Result<Vec<String>, String> {
        let output = Command::new("gopass")
            .args(["ls", "--flat"])
            .output()
            .map_err(|e| format!("Failed to run gopass: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("gopass error: {}", stderr.trim()));
        }

        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect())
    }

    /// Fetch a single secret value from gopass by its path
    pub fn fetch_value(path: &str) -> Result<String, String> {
        let output = Command::new("gopass")
            .args(["show", "-o", path])
            .output()
            .map_err(|e| format!("Failed to run gopass: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("gopass error: {}", stderr.trim()));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

}
