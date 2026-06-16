use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use crate::config::jobs::Job;
use crate::config::settings::AppSettings;
use crate::secrets::SecretsManager;

use super::params::{apply_params, collect_env_vars};
use super::tmux_spawn::{spawn_agent_pane, SpawnArgs};
use super::{project_window_name, resolve_agent_model, TmuxHandle};

pub(super) async fn execute_claude_job(
    job: &Job,
    secrets: &Arc<Mutex<SecretsManager>>,
    settings: &Arc<Mutex<AppSettings>>,
    params: &HashMap<String, String>,
    result_file: Option<&std::path::Path>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
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
            | crate::agent_session::ProcessProvider::Opencode
            | crate::agent_session::ProcessProvider::Antigravity => provider.binary_name().to_string(),
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

    let raw_prompt = std::fs::read_to_string(&job.path)
        .map_err(|e| format!("Failed to read prompt file {}: {}", job.path, e))?;
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
