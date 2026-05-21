use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;

use crate::config::jobs::Job;
use crate::config::settings::AppSettings;
use crate::secrets::SecretsManager;

use super::params::{apply_params, collect_env_vars};
use super::{project_window_name, resolve_agent_model, TmuxHandle};

pub(super) async fn execute_claude_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
    params: &HashMap<String, String>,
    result_file: Option<&std::path::Path>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
    use crate::tmux;

    let (provider, model, tmux_session, work_dir, agent_command) = {
        let s = settings.lock();
        let provider = job.agent_provider.unwrap_or(s.default_provider);
        let model = resolve_agent_model(job, &s, provider);
        let session = job
            .tmux_session
            .clone()
            .unwrap_or_else(|| s.default_tmux_session.clone());
        let wd = job
            .work_dir
            .clone()
            .unwrap_or_else(|| s.default_work_dir.clone());
        let command = match provider {
            crate::agent_session::ProcessProvider::Claude => s.claude_path.clone(),
            crate::agent_session::ProcessProvider::Codex
            | crate::agent_session::ProcessProvider::Opencode => provider.binary_name().to_string(),
            crate::agent_session::ProcessProvider::Shell => String::new(),
        };
        (provider, model, session, wd, command)
    };

    let mut env_vars = collect_env_vars(job, secrets, settings);
    if let Some(p) = result_file {
        env_vars.push((
            "CLAWTAB_RESULT_FILE".to_string(),
            p.to_string_lossy().into_owned(),
        ));
    }

    let window_name = project_window_name(job);
    let prompt_path = &job.path;

    let raw_prompt = std::fs::read_to_string(prompt_path)
        .map_err(|e| format!("Failed to read prompt file {}: {}", prompt_path, e))?;

    let raw_prompt = apply_params(raw_prompt, params);

    let prompt_content = if job.skill_paths.is_empty() {
        raw_prompt
    } else {
        let skill_refs = job
            .skill_paths
            .iter()
            .map(|p| format!("@{}", p))
            .collect::<Vec<_>>()
            .join(" ");
        format!("{}\n\n{}", skill_refs, raw_prompt)
    };

    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    if !tmux::session_exists(&tmux_session) {
        tmux::create_session(&tmux_session)?;
    }

    // Every spawn gets its own window - clawtab needs independent geometry
    // per tab, which tmux splits can't give us.
    let pane_id = tmux::create_window_with_cwd(&tmux_session, &window_name, Some(&work_dir), &env_vars)?;

    let model_flag = model
        .filter(|_| provider.supports_model_flag())
        .map(|m| provider.model_flag_format(&m))
        .unwrap_or_default();

    let escaped_prompt = prompt_content.replace('\'', "'\\''");
    let send_cmd = match provider {
        crate::agent_session::ProcessProvider::Claude
        | crate::agent_session::ProcessProvider::Codex => {
            format!(
                "cd {} && {}{} $'{}'",
                work_dir, agent_command, model_flag, escaped_prompt
            )
        }
        crate::agent_session::ProcessProvider::Opencode => {
            format!(
                "cd {} && {}{} --prompt $'{}'",
                work_dir, agent_command, model_flag, escaped_prompt
            )
        }
        crate::agent_session::ProcessProvider::Shell => {
            if escaped_prompt.is_empty() {
                format!("cd {}", work_dir)
            } else {
                format!("cd {} && {}", work_dir, escaped_prompt)
            }
        }
    };

    tmux::send_keys_to_pane(&tmux_session, &pane_id, &send_cmd)?;

    // Tag pane with job slug so reattach can identify it. Title is a
    // best-effort hint (the running process can overwrite it via escape
    // sequences); the user option is the authoritative tag.
    if let Err(e) = tmux::set_pane_title(&pane_id, &job.slug) {
        log::warn!("Failed to set pane title for '{}': {}", job.slug, e);
    }
    if let Err(e) = tmux::set_pane_slug(&pane_id, &job.slug) {
        log::warn!("Failed to set pane slug for '{}': {}", job.slug, e);
    }

    if let Some(ref workspace) = job.aerospace_workspace {
        if crate::aerospace::is_available() {
            let _ = tmux::focus_window(&tmux_session, &window_name);
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            if let Err(e) = crate::aerospace::move_window_to_workspace(workspace) {
                log::warn!(
                    "Failed to move window to aerospace workspace '{}': {}",
                    workspace,
                    e
                );
            }
        }
    }

    let handle = TmuxHandle {
        tmux_session,
        pane_id,
    };
    Ok((Some(0), String::new(), String::new(), Some(handle)))
}
