use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;

use crate::config::jobs::Job;
use crate::config::settings::AppSettings;
use crate::secrets::SecretsManager;

use super::params::{apply_params, collect_env_vars};
use super::{project_window_name, resolve_agent_model, TmuxHandle};

pub(super) async fn execute_folder_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
    params: &HashMap<String, String>,
    result_file: Option<&std::path::Path>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
    use crate::cwt::CwtFolder;
    use crate::tmux;

    let folder_path = job
        .folder_path
        .as_ref()
        .ok_or("Folder job requires folder_path")?;

    let job_id = job.job_id.as_deref().unwrap_or("default");
    let project_root = std::path::Path::new(folder_path);

    let _folder = CwtFolder::from_path_with_job(project_root, job_id)?;

    let central_job_md = crate::config::jobs::central_job_md_path(&job.slug)
        .ok_or("Could not determine config directory")?;

    if !central_job_md.exists() {
        return Err(format!(
            "No job.md found for '{}' at {}",
            job.slug,
            central_job_md.display()
        ));
    }

    let raw_prompt = std::fs::read_to_string(&central_job_md)
        .map_err(|e| format!("Failed to read {}: {}", central_job_md.display(), e))?;

    let raw_prompt = apply_params(raw_prompt, params);

    let (provider, model, tmux_session, work_dir, agent_command) = {
        let s = settings.lock();
        let provider = job.agent_provider.unwrap_or(s.default_provider);
        let model = resolve_agent_model(job, &s, provider);
        let session = job
            .tmux_session
            .clone()
            .unwrap_or_else(|| s.default_tmux_session.clone());
        let command = match provider {
            crate::agent_session::ProcessProvider::Claude => s.claude_path.clone(),
            crate::agent_session::ProcessProvider::Codex
            | crate::agent_session::ProcessProvider::Opencode => provider.binary_name().to_string(),
            crate::agent_session::ProcessProvider::Shell => String::new(),
        };
        (provider, model, session, folder_path.clone(), command)
    };

    let prompt_content = if provider == crate::agent_session::ProcessProvider::Shell {
        raw_prompt
    } else {
        // Build prompt: shared context, then per-job context, then skills, then per-job instructions.
        let shared_context = crate::config::jobs::central_project_context_path(&job.slug)
            .and_then(|p| std::fs::read_to_string(&p).ok())
            .unwrap_or_default();
        let job_context = crate::config::jobs::central_job_context_path(&job.slug)
            .and_then(|p| std::fs::read_to_string(&p).ok())
            .unwrap_or_default();

        let skill_refs = job
            .skill_paths
            .iter()
            .map(|p| format!("@{}", p))
            .collect::<Vec<_>>()
            .join(" ");
        let skill_part = if skill_refs.is_empty() {
            String::new()
        } else {
            format!(" {}", skill_refs)
        };

        let mut prompt_parts = Vec::new();
        if !shared_context.is_empty() {
            prompt_parts.push(shared_context);
        }
        if !job_context.is_empty() {
            prompt_parts.push(job_context);
        }
        if !skill_part.is_empty() {
            prompt_parts.push(skill_part.trim().to_string());
        }
        prompt_parts.push(raw_prompt);
        prompt_parts.join("\n\n")
    };

    let mut env_vars = collect_env_vars(job, secrets, settings);
    if let Some(p) = result_file {
        env_vars.push((
            "CLAWTAB_RESULT_FILE".to_string(),
            p.to_string_lossy().into_owned(),
        ));
    }
    let window_name = project_window_name(job);

    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    if !tmux::session_exists(&tmux_session) {
        tmux::create_session(&tmux_session)?;
    }

    // Every spawn gets its own window (see execute_claude_job).
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
