use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

/// Maps key name -> gopass path (e.g. "token" -> "api/token")
pub struct GopassBackend {
    cache: HashMap<String, String>,
    /// Tracks which gopass paths have been imported, keyed by derived key name
    imported_paths: HashMap<String, String>,
}

impl GopassBackend {
    pub fn new() -> Self {
        let mut backend = Self {
            cache: HashMap::new(),
            imported_paths: HashMap::new(),
        };
        backend.load_persisted_imports();
        backend
    }

    fn imports_file() -> Option<PathBuf> {
        crate::config::config_dir().map(|p| p.join("gopass_imports.yaml"))
    }

    /// Load persisted gopass paths and fetch their current values
    fn load_persisted_imports(&mut self) {
        let path = match Self::imports_file() {
            Some(p) => p,
            None => return,
        };

        if !path.exists() {
            return;
        }

        let contents = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("Failed to read gopass_imports.yaml: {}", e);
                return;
            }
        };

        let paths: HashMap<String, String> = match serde_yml::from_str(&contents) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("Failed to parse gopass_imports.yaml: {}", e);
                return;
            }
        };

        if !Self::is_available() {
            log::warn!("gopass not available, skipping import reload");
            // Still keep the paths so they persist for next startup
            self.imported_paths = paths;
            return;
        }

        for (key, gopass_path) in &paths {
            match Self::fetch_value(gopass_path) {
                Ok(value) => {
                    self.cache.insert(key.clone(), value);
                }
                Err(e) => {
                    log::warn!("Failed to fetch gopass secret '{}': {}", gopass_path, e);
                }
            }
        }

        self.imported_paths = paths;
    }

    fn save_persisted_imports(&self) {
        let path = match Self::imports_file() {
            Some(p) => p,
            None => return,
        };

        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        match serde_yml::to_string(&self.imported_paths) {
            Ok(yaml) => {
                if let Err(e) = std::fs::write(&path, yaml) {
                    log::warn!("Failed to write gopass_imports.yaml: {}", e);
                }
            }
            Err(e) => {
                log::warn!("Failed to serialize gopass imports: {}", e);
            }
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
    /// The path is persisted so it can be re-fetched on next startup.
    pub fn import(&mut self, gopass_path: &str) -> Result<String, String> {
        let value = Self::fetch_value(gopass_path)?;
        let key = gopass_path
            .rsplit('/')
            .next()
            .unwrap_or(gopass_path)
            .to_string();
        self.cache.insert(key.clone(), value);
        self.imported_paths
            .insert(key.clone(), gopass_path.to_string());
        self.save_persisted_imports();
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
        self.imported_paths.remove(key);
        self.save_persisted_imports();
    }
}
