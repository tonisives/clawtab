use crate::agent_session::ProcessProvider;
use crate::tmux;

use super::TmuxHandle;

/// Args for spawning an agent pane via tmux. Shared by Claude and Folder job types.
pub(super) struct SpawnArgs<'a> {
    pub tmux_session: String,
    pub window_name: String,
    pub work_dir: String,
    pub env_vars: Vec<(String, String)>,
    pub provider: ProcessProvider,
    pub agent_command: String,
    pub model: Option<String>,
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
        prompt_content,
        slug,
        aerospace_workspace,
    } = args;

    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    if !tmux::session_exists(&tmux_session) {
        tmux::create_session(&tmux_session)?;
    }

    // Every spawn gets its own window - clawtab needs independent geometry
    // per tab, which tmux splits can't give us.
    let pane_id =
        tmux::create_window_with_cwd(&tmux_session, &window_name, Some(&work_dir), &env_vars)?;

    let send_cmd = build_send_cmd(provider, &work_dir, &agent_command, model.as_deref(), &prompt_content);
    tmux::send_keys_to_pane(&tmux_session, &pane_id, &send_cmd)?;

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
    prompt_content: &str,
) -> String {
    let model_flag = model
        .filter(|_| provider.supports_model_flag())
        .map(|m| provider.model_flag_format(m))
        .unwrap_or_default();
    let escaped_prompt = prompt_content.replace('\'', "'\\''");

    match provider {
        ProcessProvider::Claude | ProcessProvider::Codex => format!(
            "cd {} && {}{} $'{}'",
            work_dir, agent_command, model_flag, escaped_prompt
        ),
        ProcessProvider::Opencode => format!(
            "cd {} && {}{} --prompt $'{}'",
            work_dir, agent_command, model_flag, escaped_prompt
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
