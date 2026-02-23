use std::sync::Arc;

use tauri::{Emitter, State};

use crate::config::jobs::{Job, JobStatus};
use crate::config::settings::AppSettings;
use crate::cwt::CwtFolder;
use crate::scheduler;
use crate::AppState;

#[tauri::command]
pub fn get_jobs(state: State<AppState>) -> Vec<Job> {
    state.jobs_config.lock().unwrap().jobs.clone()
}

#[tauri::command]
pub fn save_job(app: tauri::AppHandle, state: State<AppState>, job: Job) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();

    // Derive slug if not set
    let mut job = job;
    if job.slug.is_empty() {
        // If a job with the same name already exists, reuse its slug
        // to update in place instead of creating a duplicate.
        if let Some(existing) = config.jobs.iter().find(|j| j.name == job.name) {
            job.slug = existing.slug.clone();
        } else {
            job.slug = crate::config::jobs::derive_slug(
                &job.folder_path.as_deref().unwrap_or(&job.name),
                job.job_name.as_deref(),
                &config.jobs,
            );
        }
    }

    config.save_job(&job)?;

    // Refresh in-memory list
    *config = crate::config::jobs::JobsConfig::load();

    // Regenerate all cwt.md context files (agent + per-job)
    let settings = state.settings.lock().unwrap().clone();
    let jobs = config.jobs.clone();
    drop(config);
    ensure_agent_dir(&settings, &jobs);
    regenerate_all_cwt_contexts(&settings, &jobs);

    let _ = app.emit("jobs-changed", ());

    Ok(())
}

#[tauri::command]
pub fn delete_job(app: tauri::AppHandle, state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();

    let slug = config
        .jobs
        .iter()
        .find(|j| j.name == name)
        .map(|j| j.slug.clone())
        .ok_or_else(|| format!("Job not found: {}", name))?;

    config.delete_job(&slug)?;

    // Refresh in-memory list
    *config = crate::config::jobs::JobsConfig::load();

    let _ = app.emit("jobs-changed", ());

    Ok(())
}

#[tauri::command]
pub fn toggle_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.jobs_config.lock().unwrap();
    if let Some(job) = config.jobs.iter_mut().find(|j| j.name == name) {
        job.enabled = !job.enabled;
        let job = job.clone();
        config.save_job(&job)?;
        *config = crate::config::jobs::JobsConfig::load();
    }
    Ok(())
}

#[tauri::command]
pub async fn run_job_now(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let job = {
        let config = state.jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .find(|j| j.name == name)
            .cloned()
            .ok_or_else(|| format!("Job not found: {}", name))?
    };

    let secrets = Arc::clone(&state.secrets);
    let history = Arc::clone(&state.history);
    let settings = Arc::clone(&state.settings);
    let job_status = Arc::clone(&state.job_status);
    let active_agents = Arc::clone(&state.active_agents);

    tauri::async_runtime::spawn(async move {
        scheduler::executor::execute_job(
            &job,
            &secrets,
            &history,
            &settings,
            &job_status,
            "manual",
            &active_agents,
        )
        .await;
    });

    Ok(())
}

#[tauri::command]
pub fn pause_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut status = state.job_status.lock().unwrap();
    match status.get(&name) {
        Some(JobStatus::Running { .. }) => {
            status.insert(name, JobStatus::Paused);
            Ok(())
        }
        _ => Err("Job is not running".to_string()),
    }
}

#[tauri::command]
pub fn resume_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut status = state.job_status.lock().unwrap();
    match status.get(&name) {
        Some(JobStatus::Paused) => {
            status.insert(name, JobStatus::Idle);
            Ok(())
        }
        _ => Err("Job is not paused".to_string()),
    }
}

#[tauri::command]
pub fn stop_job(state: State<AppState>, name: String) -> Result<(), String> {
    let mut status = state.job_status.lock().unwrap();
    match status.get(&name).cloned() {
        Some(JobStatus::Running { pane_id: Some(pane_id), .. }) => {
            let _ = crate::tmux::kill_pane(&pane_id);
            status.insert(name, JobStatus::Idle);
            Ok(())
        }
        Some(JobStatus::Running { .. }) | Some(JobStatus::Paused) => {
            status.insert(name, JobStatus::Idle);
            Ok(())
        }
        _ => Err("Job is not running".to_string()),
    }
}

#[tauri::command]
pub async fn restart_job(state: State<'_, AppState>, name: String) -> Result<(), String> {
    let job = {
        let config = state.jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .find(|j| j.name == name)
            .cloned()
            .ok_or_else(|| format!("Job not found: {}", name))?
    };

    let secrets = Arc::clone(&state.secrets);
    let history = Arc::clone(&state.history);
    let settings = Arc::clone(&state.settings);
    let job_status = Arc::clone(&state.job_status);
    let active_agents = Arc::clone(&state.active_agents);

    tauri::async_runtime::spawn(async move {
        scheduler::executor::execute_job(
            &job,
            &secrets,
            &history,
            &settings,
            &job_status,
            "restart",
            &active_agents,
        )
        .await;
    });

    Ok(())
}

#[tauri::command]
pub fn open_job_editor(
    state: State<AppState>,
    folder_path: String,
    editor: Option<String>,
    file_name: Option<String>,
    job_name: Option<String>,
) -> Result<(), String> {
    let preferred_editor = editor.unwrap_or_else(|| {
        let s = state.settings.lock().unwrap();
        s.preferred_editor.clone()
    });

    let jn = job_name.as_deref().unwrap_or("default");
    let target_file = file_name.as_deref().unwrap_or("job.md");

    // Build file path: {folder_path}/{job_name}/{target_file}
    let file_path = std::path::Path::new(&folder_path).join(jn).join(target_file);

    // Create job.md with template if it doesn't exist (only for job.md)
    if target_file == "job.md" && !file_path.exists() {
        if let Some(parent) = file_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let template = "# Job Directions\n\nDescribe what the bot should do here.\n";
        std::fs::write(&file_path, template)
            .map_err(|e| format!("Failed to create job.md: {}", e))?;
    }

    let file_path_str = file_path.display().to_string();

    match preferred_editor.as_str() {
        "code" => {
            std::process::Command::new("code")
                .args([&folder_path, "--goto", &file_path_str])
                .spawn()
                .map_err(|e| format!("Failed to open VS Code: {}", e))?;
        }
        "codium" => {
            std::process::Command::new("codium")
                .args([&folder_path, "--goto", &file_path_str])
                .spawn()
                .map_err(|e| format!("Failed to open VSCodium: {}", e))?;
        }
        "zed" => {
            std::process::Command::new("zed")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open Zed: {}", e))?;
        }
        "subl" => {
            std::process::Command::new("subl")
                .arg(&file_path_str)
                .spawn()
                .map_err(|e| format!("Failed to open Sublime Text: {}", e))?;
        }
        // Terminal-based editors: nvim, vim, hx, emacs
        editor => {
            let cmd = format!("{} {}", editor, file_path_str);
            crate::terminal::open_in_terminal(&cmd)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn open_job_in_editor(state: State<AppState>, name: String) -> Result<(), String> {
    let config = state.jobs_config.lock().unwrap();
    let job = config
        .jobs
        .iter()
        .find(|j| j.name == name)
        .ok_or_else(|| format!("Job '{}' not found", name))?;

    // For folder jobs, open the parent of .cwt; otherwise use work_dir
    let folder = job
        .folder_path
        .as_ref()
        .and_then(|p| {
            let path = std::path::Path::new(p);
            // If path ends in .cwt, go up to the project root
            if path.file_name().map(|n| n == ".cwt").unwrap_or(false) {
                path.parent().map(|p| p.display().to_string())
            } else {
                Some(p.clone())
            }
        })
        .or_else(|| job.work_dir.clone())
        .ok_or_else(|| "Job has no folder path or working directory".to_string())?;

    let preferred_editor = {
        let s = state.settings.lock().unwrap();
        s.preferred_editor.clone()
    };

    match preferred_editor.as_str() {
        "code" => {
            std::process::Command::new("code")
                .arg(&folder)
                .spawn()
                .map_err(|e| format!("Failed to open VS Code: {}", e))?;
        }
        "codium" => {
            std::process::Command::new("codium")
                .arg(&folder)
                .spawn()
                .map_err(|e| format!("Failed to open VSCodium: {}", e))?;
        }
        "zed" => {
            std::process::Command::new("zed")
                .arg(&folder)
                .spawn()
                .map_err(|e| format!("Failed to open Zed: {}", e))?;
        }
        "subl" => {
            std::process::Command::new("subl")
                .arg(&folder)
                .spawn()
                .map_err(|e| format!("Failed to open Sublime Text: {}", e))?;
        }
        // Terminal-based editors: nvim, vim, hx, emacs
        editor => {
            let cmd = format!("cd {} && {}", folder, editor);
            crate::terminal::open_in_terminal(&cmd)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn init_cwt_folder(folder_path: String, job_name: Option<String>) -> Result<CwtFolder, String> {
    let cwt_root = std::path::Path::new(&folder_path);
    let job_name = job_name.as_deref().unwrap_or("default");

    // Create .cwt/ root if it doesn't exist
    if !cwt_root.exists() {
        std::fs::create_dir_all(cwt_root)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // Write browse.sh into the .cwt/ root (shared across all jobs)
    write_browse_sh(cwt_root);

    // Lazy migration: move .cwt/job.md -> .cwt/default/job.md if needed
    crate::config::jobs::migrate_cwt_root(cwt_root);

    // Create job subfolder
    let job_dir = cwt_root.join(job_name);
    if !job_dir.exists() {
        std::fs::create_dir_all(&job_dir)
            .map_err(|e| format!("Failed to create job directory: {}", e))?;
    }

    let job_md = job_dir.join("job.md");
    if !job_md.exists() {
        let template = "# Job Directions\n\nDescribe what the bot should do here.\n";
        std::fs::write(&job_md, template)
            .map_err(|e| format!("Failed to create job.md: {}", e))?;
    }

    CwtFolder::from_path_with_job(cwt_root, job_name)
}

/// Current version of browse.sh. Bump when the script content changes
/// so existing installations get the updated version.
const BROWSE_SH_VERSION: &str = "v2";

/// Write the browse.sh Safari helper script into a .cwt/ root directory.
/// Always overwrites if the version marker differs from BROWSE_SH_VERSION.
fn write_browse_sh(cwt_root: &std::path::Path) {
    let browse_sh = cwt_root.join("browse.sh");
    if browse_sh.exists() {
        if let Ok(existing) = std::fs::read_to_string(&browse_sh) {
            if existing.contains(&format!("# version: {}", BROWSE_SH_VERSION)) {
                return;
            }
        }
    }
    let script = format!(
        r#"#!/bin/bash
# ClawTab Safari Browser Helper
# version: {}
# Usage: ./browse.sh <command> [args...]
#   open <url>       -- Open URL in Safari
#   read             -- Get text content of active Safari tab
#   url              -- Get URL of active Safari tab
#   js <javascript>  -- Execute JavaScript in active Safari tab
#   jsfile <path>    -- Execute JavaScript from a file in active Safari tab

set -euo pipefail

case "${{1:-}}" in
  open)
    open -a Safari "${{2:?URL required}}"
    sleep 2
    ;;
  read)
    osascript -e 'tell application "Safari" to return source of front document' \
      | sed 's/<[^>]*>//g' | sed '/^$/d' | head -200
    ;;
  url)
    osascript -e 'tell application "Safari" to return URL of front document'
    ;;
  js)
    osascript -e "tell application \"Safari\" to do JavaScript \"${{2:?JS required}}\" in front document"
    ;;
  jsfile)
    JS_CODE=$(cat "${{2:?File path required}}" | tr '\n' ' ' | sed 's/"/\\"/g')
    osascript -e "tell application \"Safari\" to do JavaScript \"$JS_CODE\" in front document"
    ;;
  *)
    echo "Usage: $0 {{open|read|url|js|jsfile}} [args...]"
    exit 1
    ;;
esac
"#,
        BROWSE_SH_VERSION
    );
    if let Err(e) = std::fs::write(&browse_sh, script) {
        log::warn!("Failed to write browse.sh: {}", e);
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        if let Err(e) = std::fs::set_permissions(&browse_sh, perms) {
            log::warn!("Failed to chmod browse.sh: {}", e);
        }
    }
}

/// Current version of send.sh. Bump when the script content changes.
const SEND_SH_VERSION: &str = "v1";

/// Write the send.sh Telegram helper script into a .cwt/ root directory.
/// Always overwrites if the version marker differs from SEND_SH_VERSION.
fn write_send_sh(cwt_root: &std::path::Path, chat_id: i64) {
    let send_sh = cwt_root.join("send.sh");
    if send_sh.exists() {
        if let Ok(existing) = std::fs::read_to_string(&send_sh) {
            if existing.contains(&format!("# version: {}", SEND_SH_VERSION))
                && existing.contains(&format!("CHAT_ID={}", chat_id))
            {
                return;
            }
        }
    }
    let script = format!(
        r#"#!/bin/bash
# ClawTab Telegram Send Helper
# version: {}
# Usage: ./send.sh <message>
#   Sends an HTML-formatted message to the configured Telegram chat.

set -euo pipefail

CHAT_ID={}
MESSAGE="${{1:?Message required}}"

curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg chat_id "$CHAT_ID" --arg text "$MESSAGE" \
    '{{chat_id: ($chat_id | tonumber), text: $text, parse_mode: "HTML"}}')"
"#,
        SEND_SH_VERSION, chat_id
    );
    if let Err(e) = std::fs::write(&send_sh, script) {
        log::warn!("Failed to write send.sh: {}", e);
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        if let Err(e) = std::fs::set_permissions(&send_sh, perms) {
            log::warn!("Failed to chmod send.sh: {}", e);
        }
    }
}

#[tauri::command]
pub fn read_cwt_entry(folder_path: String, job_name: Option<String>) -> Result<String, String> {
    let cwt_root = std::path::Path::new(&folder_path);
    let job_name = job_name.as_deref().unwrap_or("default");
    let folder = CwtFolder::from_path_with_job(cwt_root, job_name)?;
    if !folder.has_entry_point {
        return Ok(String::new());
    }
    folder.read_entry_point()
}

#[tauri::command]
pub fn write_cwt_entry(folder_path: String, job_name: Option<String>, content: String) -> Result<(), String> {
    let cwt_root = std::path::Path::new(&folder_path);
    let jn = job_name.as_deref().unwrap_or("default");
    let job_md = cwt_root.join(jn).join("job.md");
    if let Some(parent) = job_md.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&job_md, content)
        .map_err(|e| format!("Failed to write {}: {}", job_md.display(), e))
}

#[tauri::command]
pub fn read_cwt_context(folder_path: String, job_name: Option<String>) -> Result<String, String> {
    let cwt_root = std::path::Path::new(&folder_path);
    let jn = job_name.as_deref().unwrap_or("default");
    let cwt_md = cwt_root.join(jn).join("cwt.md");
    if !cwt_md.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&cwt_md)
        .map_err(|e| format!("Failed to read {}: {}", cwt_md.display(), e))
}

#[tauri::command]
pub fn derive_job_slug(
    state: State<AppState>,
    folder_path: String,
    job_name: Option<String>,
) -> String {
    let config = state.jobs_config.lock().unwrap();
    crate::config::jobs::derive_slug(&folder_path, job_name.as_deref(), &config.jobs)
}

/// Generate the auto-generated cwt.md for the agent's .cwt/default/ directory.
/// Contains workspace info, available tools, and Telegram communication instructions.
fn generate_agent_cwt_context(settings: &AppSettings, jobs: &[Job], chat_id: Option<i64>) -> String {
    let mut out = String::new();

    out.push_str("<!-- Auto-generated by ClawTab. Regenerated on agent start. -->\n");
    out.push_str("# ClawTab Telegram Agent\n\n");
    out.push_str("You are the ClawTab interactive agent. The user communicates with you through Telegram.\n\n");

    // Communication protocol -- this is the most important section
    out.push_str("## Communication Protocol\n\n");
    out.push_str("IMPORTANT: You MUST send ALL your responses and questions to the user via Telegram using curl.\n");
    out.push_str("The user cannot see your terminal output. Telegram is your ONLY communication channel.\n\n");

    let has_token = settings.telegram.as_ref().map_or(false, |tg| !tg.bot_token.is_empty());
    let cid = chat_id.or_else(|| {
        settings.telegram.as_ref().and_then(|tg| tg.chat_ids.first().copied())
    });

    if has_token {
        if let Some(cid) = cid {
            out.push_str("### Sending messages\n\n");
            out.push_str("Send every response, question, status update, or result to Telegram:\n\n");
            out.push_str("```bash\n");
            out.push_str(&format!(
                "curl -s -X POST \"https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{{\"chat_id\": {}, \"text\": \"Your message here\"}}'\n",
                cid
            ));
            out.push_str("```\n\n");

            out.push_str("### Receiving messages\n\n");
            out.push_str("The user's follow-up messages are typed into your terminal input automatically by ClawTab.\n");
            out.push_str("After sending a question or completing a task, simply wait -- the user's reply will appear as your next prompt input.\n\n");
        }
    }

    out.push_str("### Rules\n\n");
    out.push_str("- ALWAYS send your answers and questions via the Telegram curl command above.\n");
    out.push_str("- After completing a task or asking a question, wait for the next input.\n");
    out.push_str("- Do NOT terminate or exit unless the user explicitly asks you to.\n");
    out.push_str("- Keep messages concise. For long output, summarize and offer to share details.\n");
    out.push_str("- Only operate within the allowed directories listed below.\n");

    // Collect unique allowed directories from jobs
    let mut dirs: Vec<String> = Vec::new();
    for job in jobs {
        if let Some(ref fp) = job.folder_path {
            if !dirs.contains(fp) {
                dirs.push(fp.clone());
            }
        }
        if let Some(ref wd) = job.work_dir {
            if !dirs.contains(wd) {
                dirs.push(wd.clone());
            }
        }
    }
    if !settings.default_work_dir.is_empty() && !dirs.contains(&settings.default_work_dir) {
        dirs.push(settings.default_work_dir.clone());
    }

    out.push_str("\n## Allowed Directories\n\n");
    for d in &dirs {
        out.push_str(&format!("- `{}`\n", d));
    }

    if let Some(config_dir) = crate::config::config_dir() {
        out.push_str(&format!("- `{}` (ClawTab config)\n", config_dir.display()));
    }

    // Workspace listing
    if !jobs.is_empty() {
        out.push_str("\n## Configured Jobs\n\n");
        for job in jobs {
            let jt = match job.job_type {
                crate::config::jobs::JobType::Binary => "bin",
                crate::config::jobs::JobType::Claude => "claude",
                crate::config::jobs::JobType::Folder => "folder",
            };
            let dir = job.folder_path.as_deref()
                .or(job.work_dir.as_deref())
                .unwrap_or("-");
            out.push_str(&format!("- `{}` [{}] dir: `{}`\n", job.name, jt, dir));
        }
    }

    out.push_str("\n## Job Management CLI\n\n");
    out.push_str("`cwtctl` is available for managing ClawTab jobs:\n\n");
    out.push_str("```\n");
    out.push_str("cwtctl ping           # Check if ClawTab daemon is running\n");
    out.push_str("cwtctl list           # List all configured jobs\n");
    out.push_str("cwtctl status         # Show status of all jobs\n");
    out.push_str("cwtctl run <name>     # Run a job immediately\n");
    out.push_str("cwtctl pause <name>   # Pause a running job\n");
    out.push_str("cwtctl resume <name>  # Resume a paused job\n");
    out.push_str("cwtctl restart <name> # Restart a job\n");
    out.push_str("```\n");

    out
}

/// Write `.claude/settings.local.json` in the given directory with default
/// permissions for automated Claude Code jobs (curl, cwtctl, kill, etc.).
fn write_claude_settings(dir: &std::path::Path) {
    let claude_dir = dir.join(".claude");
    if let Err(e) = std::fs::create_dir_all(&claude_dir) {
        log::warn!("Failed to create .claude dir in {}: {}", dir.display(), e);
        return;
    }

    let settings = serde_json::json!({
        "permissions": {
            "allow": [
                "Bash(curl *)",
                "Bash(cwtctl *)",
                "Bash(cwtctl)",
                "Bash(kill *)",
                "Bash(cat *)",
                "Bash(ls *)",
                "Bash(find *)",
                "Bash(grep *)",
                "Bash(rg *)",
                "Bash(git *)",
                "Bash(mkdir *)",
                "Bash(cp *)",
                "Bash(mv *)",
                "Bash(head *)",
                "Bash(tail *)",
                "Bash(wc *)",
                "Bash(sort *)",
                "Bash(uniq *)",
                "Bash(jq *)",
                "Bash(sed *)",
                "Bash(awk *)",
                "Bash(chmod *)",
                "Bash(.cwt/browse.sh *)",
                "Bash(./browse.sh *)",
                "Bash(.cwt/send.sh *)",
                "Bash(./send.sh *)",
                "Bash(osascript *)",
                "Bash(echo *)",
                "Bash(printf *)",
                "Bash(test *)",
                "Bash(touch *)",
                "Bash(date *)",
                "Bash(env *)",
                "Bash(which *)",
                "Bash(pwd)",
                "Bash(cd *)",
                "Bash(npm *)",
                "Bash(npx *)",
                "Bash(node *)",
                "Bash(bun *)",
                "Bash(python *)",
                "Bash(python3 *)",
                "Bash(pip *)",
                "Bash(pip3 *)",
                "Bash(cargo *)",
                "Bash(rustc *)",
                "Bash(docker *)",
                "Bash(psql *)",
                "Bash(sqlite3 *)",
                "Bash(tar *)",
                "Bash(zip *)",
                "Bash(unzip *)",
                "Bash(wget *)",
                "Bash(diff *)",
                "Bash(xargs *)",
                "Bash(tee *)",
                "Bash(cut *)",
                "Bash(tr *)",
                "Bash(basename *)",
                "Bash(dirname *)",
                "Bash(realpath *)",
                "Bash(readlink *)",
                "Bash(stat *)",
                "Bash(file *)",
                "Bash(du *)",
                "Bash(df *)",
                "Bash(uname *)",
                "Bash(whoami)",
                "Bash(hostname)",
                "Bash(brew *)",
                "Read(**)",
                "Edit(**)",
                "Write(**)",
                "WebSearch(*)",
                "WebFetch(*)",
            ]
        }
    });

    let path = claude_dir.join("settings.local.json");
    match serde_json::to_string_pretty(&settings) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                log::warn!("Failed to write {}: {}", path.display(), e);
            }
        }
        Err(e) => log::warn!("Failed to serialize claude settings: {}", e),
    }
}

/// Ensure the agent directory exists with current config.
/// Writes `cwt.md` (auto-generated) directly in the agent dir.
pub fn ensure_agent_dir(settings: &AppSettings, jobs: &[Job]) {
    let agent_dir = agent_dir_path();
    if let Err(e) = std::fs::create_dir_all(&agent_dir) {
        log::warn!("Failed to create agent dir: {}", e);
        return;
    }

    // Write auto-generated context to cwt.md (always overwritten)
    let context = generate_agent_cwt_context(settings, jobs, None);
    let cwt_md_path = agent_dir.join("cwt.md");
    if let Err(e) = std::fs::write(&cwt_md_path, context) {
        log::warn!("Failed to write agent cwt.md: {}", e);
    }

    // Write Claude Code permissions
    write_claude_settings(&agent_dir);

    // Clean up old files from previous formats
    for old in &["CLAUDE.md"] {
        let p = agent_dir.join(old);
        if p.is_file() {
            let _ = std::fs::remove_file(&p);
        }
    }
    // Clean up old .cwt/ nested structure
    let old_cwt = agent_dir.join(".cwt");
    if old_cwt.is_dir() {
        let _ = std::fs::remove_dir_all(&old_cwt);
    }
}

/// Regenerate cwt.md context file for every folder job's .cwt/{job_name}/ directory.
/// Also writes `.claude/settings.local.json` in each project root / work_dir.
pub fn regenerate_all_cwt_contexts(settings: &AppSettings, jobs: &[Job]) {
    let mut settings_written: Vec<std::path::PathBuf> = Vec::new();

    for job in jobs {
        match job.job_type {
            crate::config::jobs::JobType::Folder => {
                if let Some(ref folder_path) = job.folder_path {
                    let jn = job.job_name.as_deref().unwrap_or("default");
                    let content = generate_cwt_context(job, settings);
                    let cwt_root = std::path::Path::new(folder_path);
                    let job_dir = cwt_root.join(jn);
                    if !job_dir.exists() {
                        let _ = std::fs::create_dir_all(&job_dir);
                    }
                    let path = job_dir.join("cwt.md");
                    if let Err(e) = std::fs::write(&path, content) {
                        log::warn!("Failed to write cwt.md for '{}': {}", job.name, e);
                    }

                    // Write helper scripts into .cwt/ root
                    write_browse_sh(cwt_root);
                    let chat_id = resolve_telegram_chat_id(job, settings);
                    if let Some(cid) = chat_id {
                        write_send_sh(cwt_root, cid);
                    }

                    // Write Claude Code permissions in the project root (parent of .cwt)
                    if let Some(project_root) = cwt_root.parent() {
                        let pr = project_root.to_path_buf();
                        if !settings_written.contains(&pr) {
                            write_claude_settings(project_root);
                            settings_written.push(pr);
                        }
                    }
                }
            }
            crate::config::jobs::JobType::Claude => {
                // Claude jobs run from work_dir; write permissions there
                if let Some(ref wd) = job.work_dir {
                    let dir = std::path::PathBuf::from(wd);
                    if !settings_written.contains(&dir) {
                        write_claude_settings(&dir);
                        settings_written.push(dir);
                    }
                }
            }
            _ => {}
        }
    }

    // Also write to default_work_dir if set
    if !settings.default_work_dir.is_empty() {
        let dir = std::path::PathBuf::from(&settings.default_work_dir);
        if !settings_written.contains(&dir) && dir.is_dir() {
            write_claude_settings(&dir);
        }
    }
}

/// Returns the path to the agent working directory.
pub fn agent_dir_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".config")
        .join("clawtab")
        .join("agent")
}

fn generate_cwt_context(job: &Job, settings: &AppSettings) -> String {
    let mut out = String::new();
    let jn = job.job_name.as_deref().unwrap_or("default");

    out.push_str("<!-- Auto-generated by ClawTab. Regenerated on settings/jobs change. -->\n");
    out.push_str("# ClawTab Environment\n\n");
    out.push_str("You are running as an automated Claude Code job.\n");
    out.push_str(&format!("Job name: `{}`\n", job.name));

    out.push_str("\n## Rules\n\n");
    out.push_str("- Only edit and look for files in the current directory.\n");
    out.push_str(&format!("- The job directions are in `.cwt/{}/job.md`.\n", jn));
    out.push_str("- Shared project context is in `.cwt/cwt.md` (user-managed).\n");
    out.push_str("- When your task is fully complete and you need no further input, terminate your own process by running: `kill $PPID`\n");

    out.push_str("\n## Job Management CLI\n\n");
    out.push_str("`cwtctl` is available for managing ClawTab jobs:\n\n");
    out.push_str("```\n");
    out.push_str("cwtctl ping           # Check if ClawTab daemon is running\n");
    out.push_str("cwtctl list           # List all configured jobs\n");
    out.push_str("cwtctl status         # Show status of all jobs\n");
    out.push_str("cwtctl run <name>     # Run a job immediately\n");
    out.push_str("cwtctl pause <name>   # Pause a running job\n");
    out.push_str("cwtctl resume <name>  # Resume a paused job\n");
    out.push_str("cwtctl restart <name> # Restart a job\n");
    out.push_str("```\n");

    // Telegram section: show when a chat_id is resolvable and a bot token is available
    // (either explicitly in secret_keys or from global settings, which is auto-injected at runtime)
    let has_token = job.secret_keys.iter().any(|k| k == "TELEGRAM_BOT_TOKEN")
        || settings.telegram.as_ref().map_or(false, |tg| !tg.bot_token.is_empty());
    let chat_id = resolve_telegram_chat_id(job, settings);

    if has_token {
        if let Some(_cid) = chat_id {
            out.push_str("\n## Telegram\n\n");
            out.push_str("A `send.sh` helper script is available in the .cwt/ root.\n");
            out.push_str("Always use this script instead of raw curl commands.\n\n");
            out.push_str("```bash\n");
            out.push_str(".cwt/send.sh \"<b>Title</b>\\n\\nMessage body\"\n");
            out.push_str("```\n");
        }
    }

    // Web Browsing section
    if let Some(ref folder_path) = job.folder_path {
        let browse_sh = std::path::Path::new(folder_path).join("browse.sh");
        if browse_sh.exists() {
            out.push_str("\n## Web Browsing\n\n");
            out.push_str("A `browse.sh` helper script is available in the .cwt/ root for Safari automation.\n");
            out.push_str("Always use these helper scripts instead of running osascript or curl directly.\n\n");
            out.push_str("Usage:\n");
            out.push_str("- `.cwt/browse.sh open <url>` -- Open URL in Safari\n");
            out.push_str("- `.cwt/browse.sh read` -- Get text content of active Safari tab\n");
            out.push_str("- `.cwt/browse.sh url` -- Get URL of active Safari tab\n");
            out.push_str("- `.cwt/browse.sh js <javascript>` -- Execute short inline JavaScript in active Safari tab\n");
            out.push_str("- `.cwt/browse.sh jsfile <path>` -- Execute JavaScript from a file (use for complex extraction)\n\n");
            out.push_str("For complex JavaScript extraction, write a `.js` file and use `jsfile`:\n\n");
            out.push_str("```bash\n");
            out.push_str("# Write extraction logic to a file, then run it\n");
            out.push_str(".cwt/browse.sh jsfile .cwt/my-job/extract.js\n");
            out.push_str("```\n");
        }
    }

    // Env vars section: only if any secrets configured
    if !job.secret_keys.is_empty() {
        out.push_str("\n## Environment Variables\n\n");
        out.push_str("The following secrets are injected as env vars at runtime:\n\n");
        for key in &job.secret_keys {
            out.push_str(&format!("- `${}`\n", key));
        }
    }

    out
}

/// Build a synthetic `Job` for running Claude as an ad-hoc interactive agent.
/// Writes enriched prompt (with @.cwt references) to `~/.config/clawtab/agent/.agent-prompt.md`
/// and returns a Job that can be passed to `execute_job`.
pub fn build_agent_job(
    prompt: &str,
    chat_id: Option<i64>,
    settings: &AppSettings,
    jobs: &[Job],
) -> Result<Job, String> {
    let agent_dir = agent_dir_path();
    std::fs::create_dir_all(&agent_dir)
        .map_err(|e| format!("Failed to create agent dir: {}", e))?;

    // Regenerate the auto-generated context with the specific chat_id
    let context = generate_agent_cwt_context(settings, jobs, chat_id);
    let cwt_md_path = agent_dir.join("cwt.md");
    std::fs::write(&cwt_md_path, &context)
        .map_err(|e| format!("Failed to write agent cwt.md: {}", e))?;

    // Build the enriched prompt: absolute @cwt.md reference + user prompt
    let enriched = format!("@{}\n\n{}", cwt_md_path.display(), prompt);

    let prompt_path = agent_dir.join(".agent-prompt.md");
    std::fs::write(&prompt_path, &enriched)
        .map_err(|e| format!("Failed to write agent prompt: {}", e))?;

    Ok(Job {
        name: "agent".to_string(),
        job_type: crate::config::jobs::JobType::Claude,
        enabled: true,
        path: prompt_path.display().to_string(),
        args: Vec::new(),
        cron: String::new(),
        secret_keys: Vec::new(),
        env: std::collections::HashMap::new(),
        work_dir: Some(agent_dir.display().to_string()),
        tmux_session: None,
        aerospace_workspace: None,
        folder_path: None,
        job_name: Some("default".to_string()),
        telegram_chat_id: chat_id,
        telegram_log_mode: crate::config::jobs::TelegramLogMode::OnPrompt,
        telegram_notify: crate::config::jobs::TelegramNotify::default(),
        group: "agent".to_string(),
        slug: "agent/default".to_string(),
        skill_paths: Vec::new(),
    })
}

#[tauri::command]
pub async fn run_agent(state: State<'_, AppState>, prompt: String) -> Result<(), String> {
    let (settings, jobs) = {
        let s = state.settings.lock().unwrap().clone();
        let j = state.jobs_config.lock().unwrap().jobs.clone();
        (s, j)
    };
    let job = build_agent_job(&prompt, None, &settings, &jobs)?;

    let secrets = Arc::clone(&state.secrets);
    let history = Arc::clone(&state.history);
    let settings_arc = Arc::clone(&state.settings);
    let job_status = Arc::clone(&state.job_status);
    let active_agents = Arc::clone(&state.active_agents);

    tauri::async_runtime::spawn(async move {
        scheduler::executor::execute_job(
            &job, &secrets, &history, &settings_arc, &job_status, "manual", &active_agents,
        )
        .await;
    });

    Ok(())
}

fn resolve_telegram_chat_id(job: &Job, settings: &AppSettings) -> Option<i64> {
    // Per-job chat_id takes priority
    if let Some(cid) = job.telegram_chat_id {
        return Some(cid);
    }
    // Fall back to first global chat_id
    if let Some(ref tg) = settings.telegram {
        return tg.chat_ids.first().copied();
    }
    None
}
