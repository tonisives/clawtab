//! Headless Linux credential storage. Values are never included in diagnostics.
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::PathBuf,
};

pub struct KeychainBackend {
    cache: HashMap<String, String>,
}
impl KeychainBackend {
    pub fn new() -> Self {
        let mut backend = Self {
            cache: HashMap::new(),
        };
        backend.reload();
        backend
    }
    pub fn get(&self, key: &str) -> Option<&String> {
        self.cache.get(key)
    }
    pub fn list_keys(&self) -> Vec<String> {
        self.cache.keys().cloned().collect()
    }
    fn directory() -> Result<PathBuf, String> {
        let path = crate::config::config_dir()
            .ok_or("home directory unavailable")?
            .join("credentials");
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
            return Err("unsafe credential directory".into());
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        Ok(path)
    }
    fn read() -> Result<HashMap<String, String>, String> {
        let path = Self::directory()?.join("secrets.json");
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(e) => return Err(e.to_string()),
        };
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err("unsafe credential file permissions".into());
        }
        serde_json::from_reader(file).map_err(|_| "invalid credential file".into())
    }
    pub fn reload(&mut self) {
        match Self::read() {
            Ok(cache) => self.cache = cache,
            Err(error) => {
                self.cache.clear();
                log::warn!("Credential storage unavailable: {error}");
            }
        }
    }
    fn update(&mut self, key: &str, value: Option<&str>) -> Result<(), String> {
        let directory = Self::directory()?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(directory.join("lock"))
            .map_err(|e| e.to_string())?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err("credential lock unavailable".into());
        }
        let mut cache = Self::read()?;
        match value {
            Some(value) => {
                cache.insert(key.into(), value.into());
            }
            None => {
                cache.remove(key);
            }
        }
        let temp = directory.join(format!(".{}", uuid::Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        let result = (|| {
            serde_json::to_writer(&mut file, &cache)
                .map_err(|_| "credential encoding failed".to_string())?;
            file.flush().map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            std::fs::rename(&temp, directory.join("secrets.json")).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result?;
        self.cache = cache;
        Ok(())
    }
    pub fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        self.update(key, Some(value))
    }
    pub fn delete(&mut self, key: &str) -> Result<(), String> {
        self.update(key, None)
    }
}
