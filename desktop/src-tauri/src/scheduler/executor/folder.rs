use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use crate::config::jobs::Job;
use crate::config::settings::AppSettings;
use crate::secrets::SecretsManager;

use super::params::{apply_params, collect_env_vars};
use super::tmux_spawn::{spawn_agent_pane, SpawnArgs};
use super::{project_window_name, resolve_agent_model, TmuxHandle};

pub(super) async fn execute_folder_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
    params: &HashMap<String, String>,
    result_file: Option<&std::path::Path>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
    use crate::cwt::CwtFolder;

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
            | crate::agent_session::ProcessProvider::Opencode
            | crate::agent_session::ProcessProvider::Antigravity => {
                provider.binary_name().to_string()
            }
            crate::agent_session::ProcessProvider::Shell => String::new(),
        };
        (provider, model, session, folder_path.clone(), command)
    };

    let prompt_content = if provider == crate::agent_session::ProcessProvider::Shell {
        raw_prompt
    } else {
        build_folder_prompt(job, raw_prompt)
    };

    let mut env_vars = collect_env_vars(job, secrets, settings);
    if let Some(p) = result_file {
        env_vars.push((
            "CLAWTAB_RESULT_FILE".to_string(),
            p.to_string_lossy().into_owned(),
        ));
    }

    spawn_agent_pane(SpawnArgs {
        tmux_session,
        window_name: project_window_name(job),
        work_dir,
        env_vars,
        provider,
        agent_command,
        model,
        prompt_content,
        slug: &job.slug,
        aerospace_workspace: job.aerospace_workspace.as_deref(),
    })
    .await
}

/// Compose the folder-job prompt: shared context, per-job context, skill refs,
/// then the user's prompt. Empty parts are skipped.
fn build_folder_prompt(job: &Job, raw_prompt: String) -> String {
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

    let mut parts = Vec::new();
    if !shared_context.is_empty() {
        parts.push(shared_context);
    }
    if !job_context.is_empty() {
        parts.push(job_context);
    }
    if !skill_refs.is_empty() {
        parts.push(skill_refs);
    }
    parts.push(raw_prompt);
    parts.join("\n\n")
}
