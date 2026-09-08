pub mod git;
pub mod journal;
mod operations;
mod transfer;
use clawtab_protocol::HostRequest;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub async fn execute(request: HostRequest) -> Result<Value, String> {
    match request {
        HostRequest::DeleteJob { name } => {
            match crate::ipc::send_command(crate::ipc::IpcCommand::DeleteJob { name }).await? {
                crate::ipc::IpcResponse::Ok => Ok(json!({"removed":true})),
                crate::ipc::IpcResponse::Error(error) => Err(error),
                _ => Err("unexpected daemon response".into()),
            }
        }
        HostRequest::Info => {
            let settings = crate::config::settings::AppSettings::load();
            let tools = [
                "tmux", "git", "claude", "codex", "opencode", "agy", "python3",
            ]
            .into_iter()
            .map(|name| {
                let available = std::process::Command::new("which")
                    .arg(name)
                    .output()
                    .is_ok_and(|o| o.status.success());
                (name, available)
            })
            .collect::<std::collections::HashMap<_, _>>();
            Ok(
                json!({"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"version":env!("CARGO_PKG_VERSION"),"capabilities":["machine_v2","host_management","transfer_v1"],"home":dirs::home_dir(),"tools":tools,"models":settings.enabled_models,"machine_id":settings.relay.as_ref().map(|r|&r.device_id)}),
            )
        }
        HostRequest::Repository { path } => {
            serde_json::to_value(git::get_git_repository(path).await?).map_err(|e| e.to_string())
        }
        HostRequest::ListDirectory { path } => {
            let path = resolve_path(path.as_deref().unwrap_or("~"))?;
            let mut entries=std::fs::read_dir(&path).map_err(|e|e.to_string())?.take(1000).filter_map(Result::ok).filter_map(|entry|{
                let metadata=entry.file_type().ok()?;
                if metadata.is_symlink(){return None;}
                Some(json!({"name":entry.file_name().to_string_lossy(),"directory":metadata.is_dir()}))
            }).collect::<Vec<_>>();
            entries.sort_by_key(|v| {
                (
                    !v["directory"].as_bool().unwrap_or(false),
                    v["name"].as_str().unwrap_or_default().to_owned(),
                )
            });
            Ok(json!({"path":path,"entries":entries}))
        }
        HostRequest::Operation { operation_id } => operations::get(&operation_id),
        HostRequest::CloneRepository {
            operation_id,
            url,
            path,
        } => operations::start(
            operation_id,
            json!({"action":"clone","url":url,"path":path}),
            move || {
                if url.starts_with('-') || url.contains(['\n', '\r']) || url.contains("::") {
                    return Err("invalid repository URL".into());
                }
                let destination = resolve_path(&path)?;
                if destination.exists() {
                    return Err("destination already exists".into());
                }
                operations::git(None, &["clone", "--", &url, &destination.to_string_lossy()])?;
                Ok(json!({"path":destination}))
            },
        ),
        HostRequest::CreateWorktree {
            operation_id,
            path,
            branch,
            base,
        } => operations::start(
            operation_id,
            json!({"action":"worktree","path":path,"branch":branch,"base":base}),
            move || {
                let root = resolve_path(&path)?;
                operations::git(Some(&root), &["check-ref-format", "--branch", &branch])?;
                if base.starts_with('-') {
                    return Err("invalid base revision".into());
                }
                let destination = root
                    .join(".worktrees")
                    .join(uuid::Uuid::new_v4().to_string());
                operations::git(
                    Some(&root),
                    &[
                        "worktree",
                        "add",
                        "-b",
                        &branch,
                        &destination.to_string_lossy(),
                        &base,
                    ],
                )?;
                Ok(json!({"path":destination,"branch":branch}))
            },
        ),
        HostRequest::RemoveWorktree { operation_id, path } => operations::start(
            operation_id,
            json!({"action":"remove_worktree","path":path}),
            move || {
                let path = resolve_path(&path)?;
                let common = operations::git(
                    Some(&path),
                    &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                )?;
                let common = Path::new(common.trim())
                    .parent()
                    .ok_or("cannot find repository")?
                    .to_owned();
                if !path.starts_with(common.join(".worktrees")) {
                    return Err("only ClawTab worktrees can be removed".into());
                }
                operations::git(
                    Some(&common),
                    &["worktree", "remove", &path.to_string_lossy()],
                )?;
                Ok(json!({"removed":true}))
            },
        ),
        HostRequest::SetModels { models } => {
            let mut settings = crate::config::settings::AppSettings::load();
            settings.enabled_models = models;
            settings.save()?;
            Ok(json!({"ok":true}))
        }
        other => tokio::task::spawn_blocking(move || transfer::execute(other))
            .await
            .map_err(|e| e.to_string())?,
    }
}
pub fn resolve_path(value: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("home directory unavailable")?;
    let path = if value == "~" {
        home
    } else if let Some(rest) = value.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("absolute path required".into());
    }
    Ok(path)
}

/// Persist execution identity in tmux so daemon restarts retain it, while a new
/// pane or agent session receives a new identity.
pub fn execution_id(pane: &str, pid: &str, session: Option<&str>) -> Option<String> {
    let owner = format!("{}:{}", pid, session.unwrap_or_default());
    let output = std::process::Command::new("tmux")
        .args(["show-options", "-p", "-v", "-t", pane, "@clawtab-execution"])
        .output()
        .ok()?;
    let saved = String::from_utf8_lossy(&output.stdout);
    if let Some((saved_owner, id)) = saved.trim().rsplit_once('|') {
        if saved_owner == owner {
            return Some(id.into());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let value = format!("{owner}|{id}");
    let status = std::process::Command::new("tmux")
        .args(["set-option", "-p", "-t", pane, "@clawtab-execution", &value])
        .status()
        .ok()?;
    status.success().then_some(id)
}
pub fn validate_execution(pane: &str, expected: &str) -> bool {
    let output = std::process::Command::new("tmux")
        .args([
            "display-message",
            "-p",
            "-t",
            pane,
            "#{pane_pid}|#{@clawtab-execution}",
        ])
        .output();
    output.ok().is_some_and(|output| {
        if !output.status.success() {
            return false;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let Some((pid, saved)) = text.trim().split_once('|') else {
            return false;
        };
        let Some((owner, id)) = saved.rsplit_once('|') else {
            return false;
        };
        id == expected
            && owner
                .split_once(':')
                .is_some_and(|(saved_pid, _)| saved_pid == pid)
    })
}
