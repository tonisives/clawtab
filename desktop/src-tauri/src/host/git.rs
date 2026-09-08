use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

const MAX_DIFF_BYTES: usize = 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct GitWorktree {
    path: String,
    branch: Option<String>,
    detached: bool,
    bare: bool,
    locked: bool,
    prunable: bool,
}

#[derive(Serialize)]
pub struct GitRepository {
    root: String,
    status: String,
    staged: String,
    unstaged: String,
    truncated: bool,
    worktrees: Vec<GitWorktree>,
}

fn git_output(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut child = Command::new("git")
        .arg("--no-pager")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not run Git: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("Git output unavailable")?;
    let mut bytes = Vec::new();
    stdout
        .by_ref()
        .take((MAX_DIFF_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    std::io::copy(&mut stdout, &mut std::io::sink()).map_err(|e| e.to_string())?;
    if !child.wait().map_err(|e| e.to_string())?.success() {
        return Err("Could not inspect Git repository".into());
    }
    Ok(bytes)
}

fn parse_worktrees(bytes: &[u8]) -> Vec<GitWorktree> {
    let text = String::from_utf8_lossy(bytes);
    let mut worktrees = Vec::new();
    let mut current: Option<GitWorktree> = None;
    for field in text.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            if let Some(entry) = current.take() {
                worktrees.push(entry);
            }
            current = Some(GitWorktree {
                path: path.to_string(),
                branch: None,
                detached: false,
                bare: false,
                locked: false,
                prunable: false,
            });
        } else if let Some(entry) = current.as_mut() {
            if let Some(branch) = field.strip_prefix("branch ") {
                entry.branch = Some(
                    branch
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch)
                        .to_string(),
                );
            } else if field == "detached" {
                entry.detached = true;
            } else if field == "bare" {
                entry.bare = true;
            } else if field == "locked" || field.starts_with("locked ") {
                entry.locked = true;
            } else if field == "prunable" || field.starts_with("prunable ") {
                entry.prunable = true;
            }
        }
    }
    if let Some(entry) = current {
        worktrees.push(entry);
    }
    worktrees
}

fn bounded_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_DIFF_BYTES)]).into_owned()
}

pub async fn get_git_repository(cwd: String) -> Result<GitRepository, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&cwd);
        let root = git_output(path, &["rev-parse", "--show-toplevel"])?;
        let status = git_output(path, &["status", "--short", "--untracked-files=normal"])?;
        let unstaged = git_output(
            path,
            &["diff", "--no-ext-diff", "--no-textconv", "--no-color"],
        )?;
        let staged = git_output(
            path,
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
            ],
        )?;
        let worktrees = git_output(path, &["worktree", "list", "--porcelain", "-z"])?;
        Ok(GitRepository {
            root: String::from_utf8_lossy(&root)
                .trim_end_matches('\n')
                .to_string(),
            truncated: [status.len(), unstaged.len(), staged.len()]
                .into_iter()
                .any(|len| len > MAX_DIFF_BYTES),
            status: bounded_text(&status),
            staged: bounded_text(&staged),
            unstaged: bounded_text(&unstaged),
            worktrees: parse_worktrees(&worktrees),
        })
    })
    .await
    .map_err(|error| format!("Git inspection failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_paths_without_splitting_whitespace() {
        let entries = parse_worktrees(b"worktree /tmp/repo with space\0HEAD abc\0branch refs/heads/main\0\0worktree /tmp/new\nline\0HEAD def\0detached\0locked reason\0prunable missing\0\0");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "/tmp/repo with space");
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(entries[1].path, "/tmp/new\nline");
        assert!(entries[1].detached && entries[1].locked && entries[1].prunable);
    }

    #[test]
    fn handles_bare_worktrees() {
        let entries = parse_worktrees(b"worktree /tmp/bare\0bare\0\0");
        assert!(entries[0].bare);
        assert!(entries[0].branch.is_none());
    }

    #[test]
    fn reads_staged_unstaged_and_untracked_changes_in_an_unborn_repository() {
        let directory =
            std::env::temp_dir().join(format!("clawtab-git-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create fixture directory");
        git_output(&directory, &["init", "-q"]).expect("initialize fixture");
        std::fs::write(directory.join("tracked.txt"), "staged line\n").expect("write staged file");
        git_output(&directory, &["add", "tracked.txt"]).expect("stage fixture file");
        std::fs::write(directory.join("tracked.txt"), "unstaged line\n")
            .expect("write unstaged edit");
        std::fs::write(directory.join("untracked.txt"), "new file\n")
            .expect("write untracked file");
        let staged = git_output(
            &directory,
            &["diff", "--cached", "--no-ext-diff", "--no-textconv"],
        )
        .expect("read staged diff");
        let unstaged = git_output(&directory, &["diff", "--no-ext-diff", "--no-textconv"])
            .expect("read unstaged diff");
        let status = git_output(&directory, &["status", "--short"]).expect("read status");
        assert!(String::from_utf8_lossy(&staged).contains("+staged line"));
        assert!(String::from_utf8_lossy(&unstaged).contains("+unstaged line"));
        assert!(String::from_utf8_lossy(&status).contains("?? untracked.txt"));
        std::fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn bounds_large_diff_output() {
        assert_eq!(
            bounded_text(&vec![b'a'; MAX_DIFF_BYTES + 100]).len(),
            MAX_DIFF_BYTES
        );
    }
}
