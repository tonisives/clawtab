use crate::agent_session::ProcessProvider;
use crate::tmux;

use super::TmuxHandle;
use std::io::Write;
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

/// Args for spawning an agent pane via tmux. Shared by Claude and Folder job types.
pub(super) struct SpawnArgs<'a> {
    pub tmux_session: String,
    pub window_name: String,
    pub work_dir: String,
    pub env_vars: Vec<(String, String)>,
    pub provider: ProcessProvider,
    pub agent_command: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub prompt_content: String,
    pub slug: &'a str,
    pub aerospace_workspace: Option<&'a str>,
}

/// Create the tmux window, send the agent command, tag the pane, and optionally
/// move the window to an aerospace workspace. Returns the same shape callers
/// expect from per-type executors so they can `return spawn_agent_pane(...).await`.
pub(super) async fn spawn_agent_pane(
    args: SpawnArgs<'_>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
    let SpawnArgs {
        tmux_session,
        window_name,
        work_dir,
        env_vars,
        provider,
        agent_command,
        model,
        effort,
        prompt_content,
        slug,
        aerospace_workspace,
    } = args;

    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    let prompt_file = if provider == ProcessProvider::Shell {
        None
    } else {
        Some(write_prompt_file(&prompt_content)?)
    };

    if !tmux::session_exists(&tmux_session) {
        if let Err(error) = tmux::create_session(&tmux_session) {
            remove_prompt_file(prompt_file.as_deref());
            return Err(error);
        }
    }

    // Every spawn gets its own window - clawtab needs independent geometry
    // per tab, which tmux splits can't give us.
    let pane_id =
        match tmux::create_window_with_cwd(&tmux_session, &window_name, Some(&work_dir), &env_vars)
        {
            Ok(pane_id) => pane_id,
            Err(error) => {
                remove_prompt_file(prompt_file.as_deref());
                return Err(error);
            }
        };

    let send_cmd = build_send_cmd(
        provider,
        &work_dir,
        &agent_command,
        model.as_deref(),
        effort.as_deref(),
        prompt_file.as_deref(),
        &prompt_content,
    );
    if let Err(error) = tmux::send_keys_to_pane(&tmux_session, &pane_id, &send_cmd) {
        remove_prompt_file(prompt_file.as_deref());
        return Err(error);
    }

    tag_pane(&pane_id, slug);

    if let Some(workspace) = aerospace_workspace {
        move_to_aerospace_workspace(&tmux_session, &window_name, workspace).await;
    }

    let handle = TmuxHandle {
        tmux_session,
        pane_id,
    };
    Ok((Some(0), String::new(), String::new(), Some(handle)))
}

/// Compose the shell command sent to the pane: cd into the work dir, then
/// invoke the agent (or just leave a shell prompt for ProcessProvider::Shell).
fn build_send_cmd(
    provider: ProcessProvider,
    work_dir: &str,
    agent_command: &str,
    model: Option<&str>,
    effort: Option<&str>,
    prompt_file: Option<&Path>,
    prompt_content: &str,
) -> String {
    let model_flag = model
        .filter(|_| provider.supports_model_flag())
        .map(|m| provider.model_flag_format(m))
        .unwrap_or_default();
    let effort_flag = effort
        .filter(|value| matches!(*value, "low" | "medium" | "high" | "xhigh" | "max"))
        .map(|value| provider.effort_flag_format(value))
        .unwrap_or_default();
    let escaped_prompt = prompt_content.replace('\'', "'\\''");
    let prompt_arg = prompt_file
        .map(|path| format!("\"$(cat {})\"", shell_quote(&path.display().to_string())))
        .unwrap_or_else(|| format!("$'{}'", escaped_prompt));
    let cleanup = prompt_file
        .map(|path| {
            format!(
                "; status=$?; rm -f {}; exit $status",
                shell_quote(&path.display().to_string())
            )
        })
        .unwrap_or_default();

    match provider {
        ProcessProvider::Claude | ProcessProvider::Codex => format!(
            "cd {} && {}{}{} {}{}",
            work_dir, agent_command, model_flag, effort_flag, prompt_arg, cleanup
        ),
        ProcessProvider::Opencode => format!(
            "cd {} && {}{}{} --prompt {}{}",
            work_dir, agent_command, model_flag, effort_flag, prompt_arg, cleanup
        ),
        ProcessProvider::Antigravity => format!(
            "cd {} && {}{}{} --prompt-interactive {}{}",
            work_dir, agent_command, model_flag, effort_flag, prompt_arg, cleanup
        ),
        ProcessProvider::Shell => {
            if escaped_prompt.is_empty() {
                format!("cd {}", work_dir)
            } else {
                format!("cd {} && {}", work_dir, escaped_prompt)
            }
        }
    }
}

/// Store the assembled prompt outside the tmux command line. tmux has a much
/// smaller practical argument limit than the agent process, and folder jobs
/// can combine several context files into a prompt larger than that limit.
fn write_prompt_file(prompt_content: &str) -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join(format!("clawtab-prompt-{}.md", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);

    let mut file = options
        .open(&path)
        .map_err(|error| format!("Failed to create prompt file {}: {}", path.display(), error))?;
    if let Err(error) = file
        .write_all(prompt_content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = std::fs::remove_file(&path);
        return Err(format!(
            "Failed to write prompt file {}: {}",
            path.display(),
            error
        ));
    }
    Ok(path)
}

fn remove_prompt_file(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_prompt_is_loaded_from_a_file() {
        let prompt_file = Path::new("/tmp/clawtab-prompt-test.md");
        let command = build_send_cmd(
            ProcessProvider::Codex,
            "/tmp/project",
            "codex",
            Some("gpt-5.6"),
            Some("max"),
            Some(prompt_file),
            "prompt content must not be embedded",
        );

        assert!(command.contains("\"$(cat '/tmp/clawtab-prompt-test.md')\""));
        assert!(command.contains("rm -f '/tmp/clawtab-prompt-test.md'"));
        assert!(!command.contains("prompt content must not be embedded"));
    }

    #[test]
    fn shell_prompt_keeps_existing_inline_behavior() {
        let command = build_send_cmd(
            ProcessProvider::Shell,
            "/tmp/project",
            "",
            None,
            None,
            None,
            "echo hello",
        );

        assert_eq!(command, "cd /tmp/project && echo hello");
    }
}

/// Tag the pane with the job slug so reattach can identify it. Title is a
/// best-effort hint (the running process can overwrite it via escape sequences);
/// the user option is the authoritative tag.
fn tag_pane(pane_id: &str, slug: &str) {
    if let Err(e) = tmux::set_pane_title(pane_id, slug) {
        log::warn!("Failed to set pane title for '{}': {}", slug, e);
    }
    if let Err(e) = tmux::set_pane_slug(pane_id, slug) {
        log::warn!("Failed to set pane slug for '{}': {}", slug, e);
    }
}

/// Focus the new tmux window then move it to the named aerospace workspace.
/// No-op when aerospace isn't available. The sleep gives aerospace a moment
/// to register the focus change before the move.
async fn move_to_aerospace_workspace(tmux_session: &str, window_name: &str, workspace: &str) {
    if !crate::aerospace::is_available() {
        return;
    }
    let _ = tmux::focus_window(tmux_session, window_name);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    if let Err(e) = crate::aerospace::move_window_to_workspace(workspace) {
        log::warn!(
            "Failed to move window to aerospace workspace '{}': {}",
            workspace,
            e
        );
    }
}
