use super::{SessionInfo, Snapshot, PREFIX};
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn root() -> Result<PathBuf, String> {
    let root = std::env::var_os("CLAWTAB_SESSION_DIR")
        .map(PathBuf::from)
        .or_else(|| crate::config::config_dir().map(|path| path.join("sessions")))
        .ok_or("configuration directory unavailable")?;
    crate::local_transport::private_directory(&root)?;
    Ok(root)
}

pub fn directory(id: &str) -> Result<PathBuf, String> {
    let value = id
        .strip_prefix(PREFIX)
        .ok_or("invalid managed session ID")?;
    let uuid = uuid::Uuid::parse_str(value).map_err(|_| "invalid managed session ID")?;
    Ok(root()?.join(uuid.to_string()))
}

pub fn endpoint(id: &str) -> Result<PathBuf, String> {
    // Unix socket paths have small limits; keep sockets out of deep config paths.
    let uuid = id
        .strip_prefix(PREFIX)
        .filter(|_| super::is_managed(id))
        .ok_or("invalid managed session ID")?;
    Ok(crate::runtime_paths::ensure()?.join(format!("session-{uuid}.sock")))
}

pub fn save<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid session path")?;
    crate::local_transport::private_directory(parent)?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = crate::local_transport::private_file(&temp)?;
        serde_json::to_writer(&mut file, value).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        crate::local_transport::atomic_replace(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

pub fn read_info(id: &str) -> Result<SessionInfo, String> {
    read(&directory(id)?.join("session.json"))
}

pub fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 {
        return Err("invalid session file".into());
    }
    serde_json::from_reader(std::fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub fn save_info(info: &SessionInfo) -> Result<(), String> {
    save(&directory(&info.id)?.join("session.json"), info)
}

pub fn final_snapshot(id: &str) -> Result<Snapshot, String> {
    read(&directory(id)?.join("screen.json"))
}
