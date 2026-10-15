#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::PathBuf;

pub fn directory() -> PathBuf {
    #[cfg(windows)]
    {
        dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("ClawTab")
            .join("runtime")
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::temp_dir().join(format!("clawtab-{}", unsafe { libc::geteuid() }))
            })
            .join("clawtab")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/tmp/clawtab")
    }
}
pub fn ensure() -> Result<PathBuf, String> {
    let path = directory();
    #[cfg(windows)]
    {
        crate::local_transport::private_directory(&path)?;
        return Ok(path);
    }
    #[cfg(unix)]
    {
        #[cfg(target_os = "linux")]
        if let Some(parent) = path.parent() {
            use std::os::unix::fs::DirBuilderExt;
            match std::fs::DirBuilder::new().mode(0o700).create(parent) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.to_string()),
            }
            let meta = std::fs::symlink_metadata(parent).map_err(|e| e.to_string())?;
            if !meta.is_dir()
                || meta.uid() != unsafe { libc::geteuid() }
                || meta.mode() & 0o077 != 0
            {
                return Err("unsafe runtime parent directory".into());
            }
        }
        match std::fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
            return Err("unsafe runtime directory ownership".into());
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        Ok(path)
    }
}
pub fn socket(name: &str, legacy: &str) -> PathBuf {
    #[cfg(windows)]
    {
        let _ = legacy;
        directory().join(name)
    }
    #[cfg(target_os = "linux")]
    {
        let _ = legacy;
        directory().join(name)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = name;
        PathBuf::from(legacy)
    }
}
pub fn lock() -> PathBuf {
    directory().join("daemon.lock")
}
