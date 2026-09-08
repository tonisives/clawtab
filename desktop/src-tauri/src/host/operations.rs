use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

static WORKER: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| uuid::Uuid::new_v4().to_string());

pub fn directory(id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "operation ID must be a UUID")?;
    let path = crate::config::config_dir()
        .ok_or("config directory unavailable")?
        .join("operations")
        .join(id);
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    if !std::fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("unsafe operation directory".into());
    }
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    Ok(path)
}
pub fn get(id: &str) -> Result<Value, String> {
    let directory = directory(id)?;
    let path = if directory.join("launch-result.json").exists() {
        directory.join("launch-result.json")
    } else {
        directory.join("result.json")
    };
    if !path.exists() && directory.join("launch-request.json").exists() {
        return Ok(
            json!({"operation_id":id,"status":"pending","message":"Launch was accepted; inspect the machine before starting another operation"}),
        );
    }
    let bytes = std::fs::read(&path).map_err(|_| "operation not found")?;
    let mut value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "invalid operation record")?;
    if path.ends_with("launch-result.json") {
        return Ok(
            json!({"operation_id":id,"status":if value["success"]==false || value["type"]=="error"{"failed"}else{"completed"},"result":value}),
        );
    }
    if value["status"] == "running" && value["worker"].as_str() != Some(WORKER.as_str()) {
        value["status"] = json!("interrupted");
        value["message"] =
            json!("Daemon restarted; inspect the destination before starting another operation");
    }
    Ok(value)
}
fn save(path: &Path, value: &Value) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}
pub fn start<F>(id: String, request: Value, work: F) -> Result<Value, String>
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    let dir = directory(&id)?;
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("request.json"))
    {
        Ok(mut file) => {
            file.write_all(request.to_string().as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let original: Value = serde_json::from_slice(
                &std::fs::read(dir.join("request.json")).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            if original != request {
                return Err("operation ID already used for another request".into());
            }
            return get(&id);
        }
        Err(e) => return Err(e.to_string()),
    }
    let pending = json!({"operation_id":id,"status":"running","worker":*WORKER});
    save(&dir.join("result.json"), &pending)?;
    tokio::task::spawn_blocking(move || {
        let result = match work() {
            Ok(value) => json!({"operation_id":id,"status":"completed","result":value}),
            Err(error) => json!({"operation_id":id,"status":"failed","error":error}),
        };
        if let Err(error) = save(&dir.join("result.json"), &result) {
            log::error!("Could not save operation result: {error}");
        }
    });
    Ok(pending)
}
pub fn git(cwd: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("--no-pager");
    if let Some(path) = cwd {
        command.arg("-C").arg(path);
    }
    let output = command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Git operation failed ({}); verify the branch, repository path, and host credentials",
            output.status
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
