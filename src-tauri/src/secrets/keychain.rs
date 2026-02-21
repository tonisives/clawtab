use std::collections::HashMap;

const SERVICE_NAME: &str = "cc.clawtab";

pub struct KeychainBackend {
    cache: HashMap<String, String>,
}

impl KeychainBackend {
    pub fn new() -> Self {
        let mut backend = Self {
            cache: HashMap::new(),
        };
        backend.reload_all();
        backend
    }

    pub fn get(&self, key: &str) -> Option<&String> {
        self.cache.get(key)
    }

    pub fn list_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.cache.keys().cloned().collect();
        keys.sort();
        keys
    }

    pub fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        // Delete existing entry first (security CLI errors if it already exists)
        let _ = std::process::Command::new("security")
            .args(["delete-generic-password", "-s", SERVICE_NAME, "-a", key])
            .output();

        let output = std::process::Command::new("security")
            .args([
                "add-generic-password",
                "-s",
                SERVICE_NAME,
                "-a",
                key,
                "-w",
                value,
                "-U",
            ])
            .output()
            .map_err(|e| format!("Failed to run security command: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Keychain error: {}", stderr.trim()));
        }

        self.cache.insert(key.to_string(), value.to_string());
        Ok(())
    }

    pub fn delete(&mut self, key: &str) -> Result<(), String> {
        let output = std::process::Command::new("security")
            .args(["delete-generic-password", "-s", SERVICE_NAME, "-a", key])
            .output()
            .map_err(|e| format!("Failed to run security command: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Keychain error: {}", stderr.trim()));
        }

        self.cache.remove(key);
        Ok(())
    }

    fn reload_all(&mut self) {
        let output = std::process::Command::new("security")
            .args(["dump-keychain"])
            .output();

        let output = match output {
            Ok(o) => o,
            Err(e) => {
                log::warn!("Failed to dump keychain: {}", e);
                return;
            }
        };

        let text = String::from_utf8_lossy(&output.stdout);
        let mut current_is_ours = false;
        let mut current_account: Option<String> = None;

        for line in text.lines() {
            let trimmed = line.trim();

            if trimmed.starts_with("keychain:") {
                current_is_ours = false;
                current_account = None;
            }

            if trimmed.contains(&format!("\"svce\"<blob>=\"{}\"", SERVICE_NAME)) {
                current_is_ours = true;
            }

            if let Some(rest) = trimmed.strip_prefix("\"acct\"<blob>=") {
                let acct = rest.trim_matches('"');
                current_account = Some(acct.to_string());
            }

            if current_is_ours {
                if let Some(ref acct) = current_account {
                    if let Some(value) = read_keychain_value(acct) {
                        self.cache.insert(acct.clone(), value);
                    }
                    current_is_ours = false;
                    current_account = None;
                }
            }
        }
    }
}

fn read_keychain_value(key: &str) -> Option<String> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", SERVICE_NAME, "-a", key, "-w"])
        .output()
        .ok()?;

    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    } else {
        None
    }
}
