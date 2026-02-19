use std::collections::HashMap;
use std::process::Command;

pub struct GopassBackend {
    cache: HashMap<String, String>,
}

impl GopassBackend {
    pub fn new() -> Self {
        Self {
            cache: HashMap::new(),
        }
    }

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

    /// Fetch a single secret value from gopass
    fn fetch_value(path: &str) -> Result<String, String> {
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

    /// Import a gopass entry into the local cache by its gopass path.
    /// The key used in the cache is the last segment of the path (e.g. "api/token" -> "token").
    pub fn import(&mut self, gopass_path: &str) -> Result<String, String> {
        let value = Self::fetch_value(gopass_path)?;
        let key = gopass_path
            .rsplit('/')
            .next()
            .unwrap_or(gopass_path)
            .to_string();
        self.cache.insert(key.clone(), value);
        Ok(key)
    }

    pub fn get(&self, key: &str) -> Option<&String> {
        self.cache.get(key)
    }

    pub fn list_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.cache.keys().cloned().collect();
        keys.sort();
        keys
    }

    pub fn remove(&mut self, key: &str) {
        self.cache.remove(key);
    }
}
