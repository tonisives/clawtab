pub mod gopass;
pub mod keychain;

use serde::Serialize;

use self::keychain::KeychainBackend;

#[derive(Debug, Clone, Serialize)]
pub struct SecretEntry {
    pub key: String,
    pub source: SecretSource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretSource {
    Keychain,
}

pub struct SecretsManager {
    keychain: KeychainBackend,
}

impl SecretsManager {
    pub fn new() -> Self {
        Self {
            keychain: KeychainBackend::new(),
        }
    }

    /// Get a secret value by key from keychain
    pub fn get(&self, key: &str) -> Option<&String> {
        self.keychain.get(key)
    }

    /// List all secret keys with their source
    pub fn list_entries(&self) -> Vec<SecretEntry> {
        let mut entries: Vec<SecretEntry> = self
            .keychain
            .list_keys()
            .into_iter()
            .map(|key| SecretEntry {
                key,
                source: SecretSource::Keychain,
            })
            .collect();

        entries.sort_by(|a, b| a.key.cmp(&b.key));
        entries
    }

    /// List just the key names
    pub fn list_keys(&self) -> Vec<String> {
        self.list_entries().into_iter().map(|e| e.key).collect()
    }

    /// Set a secret in keychain
    pub fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        self.keychain.set(key, value)
    }

    /// Delete a secret from keychain
    pub fn delete(&mut self, key: &str) -> Result<(), String> {
        self.keychain.delete(key)
    }

    /// Check if gopass is available on the system
    pub fn gopass_available(&self) -> bool {
        gopass::GopassBackend::is_available()
    }

    /// List all entries in the gopass store
    pub fn list_gopass_store(&self) -> Result<Vec<String>, String> {
        gopass::GopassBackend::list_entries()
    }
}
