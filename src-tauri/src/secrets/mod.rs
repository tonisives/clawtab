pub mod gopass;
pub mod keychain;

use serde::Serialize;

use self::gopass::GopassBackend;
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
    Gopass,
}

pub struct SecretsManager {
    keychain: KeychainBackend,
    gopass: GopassBackend,
}

impl SecretsManager {
    pub fn new() -> Self {
        Self {
            keychain: KeychainBackend::new(),
            gopass: GopassBackend::new(),
        }
    }

    /// Get a secret value by key, searching keychain first then gopass
    pub fn get(&self, key: &str) -> Option<&String> {
        self.keychain.get(key).or_else(|| self.gopass.get(key))
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

        for key in self.gopass.list_keys() {
            entries.push(SecretEntry {
                key,
                source: SecretSource::Gopass,
            });
        }

        entries.sort_by(|a, b| a.key.cmp(&b.key));
        entries
    }

    /// List just the key names (for backwards compatibility)
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

    /// Import a gopass entry into the local gopass cache
    pub fn import_gopass(&mut self, gopass_path: &str) -> Result<String, String> {
        self.gopass.import(gopass_path)
    }

    /// Remove a gopass entry from the local cache (does not delete from gopass store)
    pub fn remove_gopass(&mut self, key: &str) {
        self.gopass.remove(key);
    }

    /// Check if gopass is available on the system
    pub fn gopass_available(&self) -> bool {
        GopassBackend::is_available()
    }

    /// List all entries in the gopass store
    pub fn list_gopass_store(&self) -> Result<Vec<String>, String> {
        GopassBackend::list_entries()
    }
}
