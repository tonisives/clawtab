use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::{DateTime, Local, TimeZone};
use clawtab_lib::config::jobs::{
    derive_slug, Job, JobType, JobsConfig, NotifyTarget, RunOnceSchedule, TelegramLogMode,
    TelegramNotify,
};
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Terminal;

#[derive(Default)]
struct CreateInput {
    name: String,
    cron: Option<String>,
    at: Option<String>,
    description: Option<String>,
    file: Option<PathBuf>,
    stdin: bool,
    keep_config: bool,
}

struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = io::stdout().execute(LeaveAlternateScreen);
    }
}

pub fn create(args: &[String]) -> Result<(), String> {
    if args.len() == 1 && matches!(args[0].as_str(), "--help" | "-h") {
        println!("Usage: cwtctl jobs create [--name NAME (--cron EXPR | --at 'YYYY-MM-DD HH:MM') (--description TEXT | --description-file PATH | --description-stdin) [--keep-config]]");
        println!("With no options, opens the interactive job creator and nvim.");
        return Ok(());
    }
    let mut input = if args.is_empty() {
        let Some(input) = interactive()? else {
            return Ok(());
        };
        input
    } else {
        parse_args(args)?
    };
    validate_fields(&input)?;
    let source_count = usize::from(input.description.is_some())
        + usize::from(input.file.is_some())
        + usize::from(input.stdin);
    if source_count != 1 {
        return Err("provide exactly one description source".into());
    }
    let description = if let Some(text) = input.description.take() {
        text
    } else if let Some(path) = input.file.take() {
        fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?
    } else if input.stdin {
        let mut text = String::new();
        io::stdin()
            .read_to_string(&mut text)
            .map_err(|error| error.to_string())?;
        text
    } else {
        return Err("provide one description source".into());
    };
    save(input, description)
}

fn parse_args(args: &[String]) -> Result<CreateInput, String> {
    let mut input = CreateInput::default();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if flag == "--keep-config" {
            input.keep_config = true;
            index += 1;
            continue;
        }
        if flag == "--description-stdin" {
            input.stdin = true;
            index += 1;
            continue;
        }
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("{flag} requires a value"))?;
        match flag {
            "--name" => input.name = value.clone(),
            "--cron" => input.cron = Some(value.clone()),
            "--at" => input.at = Some(value.clone()),
            "--description" => input.description = Some(value.clone()),
            "--description-file" => input.file = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown option: {flag}")),
        }
        index += 2;
    }
    Ok(input)
}

fn interactive() -> Result<Option<CreateInput>, String> {
    let mut input = CreateInput::default();
    let mut fields = [String::new(), String::new()];
    let mut focused = 0usize;
    let mut once = true;
    let mut error = String::new();
    enable_raw_mode().map_err(|error| error.to_string())?;
    let guard = TerminalGuard;
    io::stdout()
        .execute(EnterAlternateScreen)
        .map_err(|error| error.to_string())?;
    let mut terminal = Terminal::new(ratatui::backend::CrosstermBackend::new(io::stdout()))
        .map_err(|error| error.to_string())?;
    let result: Result<Option<CreateInput>, String> = loop {
        terminal.draw(|frame| {
            let area = frame.area();
            let text = format!(
                "Name: {}{}\nSchedule: {}\n{}: {}{}\nRemove config after start: {}\n\n{}\nTab: next field  Ctrl-R: schedule type  Ctrl-K: toggle cleanup\nEnter: write description in nvim  Esc: cancel",
                fields[0], if focused == 0 { "_" } else { "" },
                if once { "One-time" } else { "Cron" },
                if once { "Date/time" } else { "Cron expression" },
                fields[1], if focused == 1 { "_" } else { "" },
                if !once { "n/a" } else if input.keep_config { "No" } else { "Yes" },
                error,
            );
            frame.render_widget(Paragraph::new(text).block(Block::default().title("Create job").borders(Borders::ALL)), area);
        }).map_err(|error| error.to_string())?;
        let Event::Key(key) = event::read().map_err(|error| error.to_string())? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Esc => break Ok(None),
            KeyCode::Char('c')
                if key
                    .modifiers
                    .contains(crossterm::event::KeyModifiers::CONTROL) =>
            {
                break Ok(None)
            }
            KeyCode::Tab => focused = (focused + 1) % fields.len(),
            KeyCode::Char('r')
                if key
                    .modifiers
                    .contains(crossterm::event::KeyModifiers::CONTROL) =>
            {
                once = !once;
                if !once {
                    input.keep_config = false;
                }
            }
            KeyCode::Char('k')
                if once
                    && key
                        .modifiers
                        .contains(crossterm::event::KeyModifiers::CONTROL) =>
            {
                input.keep_config = !input.keep_config
            }
            KeyCode::Enter => {
                input.name = fields[0].clone();
                if once {
                    input.at = Some(fields[1].clone());
                } else {
                    input.cron = Some(fields[1].clone());
                }
                match validate_fields(&input) {
                    Ok(()) => break Ok(Some(input)),
                    Err(message) => {
                        error = message;
                        input.cron = None;
                        input.at = None;
                    }
                }
            }
            KeyCode::Backspace => {
                fields[focused].pop();
            }
            KeyCode::Char(ch) => fields[focused].push(ch),
            _ => {}
        }
    };
    drop(terminal);
    drop(guard);
    let mut input = match result? {
        Some(input) => input,
        None => return Ok(None),
    };
    input.description = Some(edit_description()?);
    Ok(Some(input))
}

fn edit_description() -> Result<String, String> {
    let path = std::env::temp_dir().join(format!("clawtab-job-{}.md", uuid::Uuid::new_v4()));
    fs::write(&path, "").map_err(|error| error.to_string())?;
    let status = Command::new("nvim").arg(&path).status();
    let text = fs::read_to_string(&path).map_err(|error| error.to_string());
    let _ = fs::remove_file(&path);
    let status = status.map_err(|error| format!("nvim: {error}"))?;
    if !status.success() {
        return Err("nvim exited without saving the job".into());
    }
    text
}

fn parse_at(value: &str) -> Result<DateTime<chrono::FixedOffset>, String> {
    if let Ok(at) = DateTime::parse_from_rfc3339(value) {
        return Ok(at);
    }
    let local = ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"]
        .into_iter()
        .find_map(|format| chrono::NaiveDateTime::parse_from_str(value, format).ok())
        .ok_or("date must be YYYY-MM-DD HH:MM or RFC 3339")?;
    Local
        .from_local_datetime(&local)
        .single()
        .map(|at| at.fixed_offset())
        .ok_or_else(|| "local date/time is ambiguous or does not exist".into())
}

fn save(input: CreateInput, description: String) -> Result<(), String> {
    validate_fields(&input)?;
    let name = input.name.trim();
    if description.trim().is_empty() {
        return Err("description cannot be empty".into());
    }
    let run_once = if let Some(value) = &input.at {
        let at = parse_at(value)?;
        Some(RunOnceSchedule {
            at,
            remove_after_start: !input.keep_config,
        })
    } else {
        None
    };

    let cwd = fs::canonicalize(std::env::current_dir().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let config = JobsConfig::load();
    let (project_root, matched_group) = project_for_cwd(&config.jobs, &cwd);
    let derived = derive_slug(&matched_group, Some(name), &config.jobs);
    let (normalized_group, job_suffix) = derived.split_once('/').ok_or("invalid job slug")?;
    let group = if config.jobs.iter().any(|job| {
        job.group == matched_group
            && job
                .folder_path
                .as_ref()
                .and_then(|path| fs::canonicalize(path).ok())
                .as_deref()
                == Some(project_root.as_path())
    }) {
        matched_group
    } else {
        normalized_group.to_string()
    };
    if config
        .jobs
        .iter()
        .any(|job| job.group == group && job.name == name)
    {
        return Err(format!("job already exists: {group}/{name}"));
    }
    let slug = format!("{group}/{job_suffix}");
    let job_id = slug.split('/').next_back().unwrap_or(name).to_string();
    let folder_path = project_root.to_string_lossy().into_owned();
    let job = Job {
        name: name.to_string(),
        job_type: JobType::Job,
        enabled: true,
        path: String::new(),
        args: Vec::new(),
        cron: input.cron.unwrap_or_default(),
        schedule: None,
        run_once,
        secret_keys: Vec::new(),
        env: Default::default(),
        work_dir: None,
        tmux_session: None,
        aerospace_workspace: None,
        folder_path: Some(folder_path),
        job_id: Some(job_id),
        telegram_chat_id: None,
        telegram_log_mode: TelegramLogMode::OnPrompt,
        telegram_notify: TelegramNotify::default(),
        notify_target: NotifyTarget::None,
        group,
        slug: slug.clone(),
        skill_paths: Vec::new(),
        params: Vec::new(),
        kill_on_end: false,
        auto_yes: true,
        agent_provider: None,
        agent_model: None,
        agent_effort: None,
        added_at: None,
        max_history: 3,
    };
    let jobs_dir = JobsConfig::jobs_dir_public().ok_or("cannot determine config directory")?;
    let path = jobs_dir.join(&slug);
    fs::create_dir_all(path.parent().ok_or("invalid job folder")?)
        .map_err(|error| error.to_string())?;
    fs::create_dir(&path)
        .map_err(|error| format!("cannot create job folder {}: {error}", path.display()))?;
    if let Err(error) = fs::write(path.join("job.md"), description)
        .map_err(|error| error.to_string())
        .and_then(|_| config.save_job(&job))
    {
        let _ = fs::remove_dir_all(&path);
        return Err(error);
    }
    println!("Created {slug}");
    Ok(())
}

fn validate_fields(input: &CreateInput) -> Result<(), String> {
    let name = input.name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err("name must be nonempty and cannot contain path separators".into());
    }
    if usize::from(input.cron.is_some()) + usize::from(input.at.is_some()) != 1 {
        return Err("provide exactly one of --cron or --at".into());
    }
    if let Some(cron) = &input.cron {
        if clawtab_lib::scheduler::parse_cron(cron).is_none() {
            return Err("invalid cron expression".into());
        }
    }
    if let Some(value) = &input.at {
        if parse_at(value)? <= Local::now() {
            return Err("one-time date must be in the future".into());
        }
    } else if input.keep_config {
        return Err("--keep-config applies only to one-time jobs".into());
    }
    Ok(())
}

fn project_for_cwd(jobs: &[Job], cwd: &Path) -> (PathBuf, String) {
    jobs.iter()
        .filter_map(|job| {
            let path = job.folder_path.as_ref()?;
            let root = fs::canonicalize(path).ok()?;
            cwd.starts_with(&root).then_some((root, job.group.clone()))
        })
        .max_by_key(|(root, _)| root.components().count())
        .unwrap_or_else(|| {
            let name = cwd
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            (cwd.to_path_buf(), name)
        })
}

#[cfg(test)]
mod tests {
    use super::{parse_args, parse_at, project_for_cwd};

    #[test]
    fn date_with_offset_parses() {
        assert_eq!(
            parse_at("2026-10-02T09:00:00+07:00")
                .unwrap()
                .offset()
                .local_minus_utc(),
            7 * 3600
        );
    }

    #[test]
    fn stdin_flag_does_not_consume_following_option() {
        let args = [
            "--description-stdin",
            "--name",
            "review",
            "--cron",
            "0 9 * * *",
        ]
        .map(String::from);
        let input = parse_args(&args).unwrap();
        assert!(input.stdin);
        assert_eq!(input.name, "review");
        assert_eq!(input.cron.as_deref(), Some("0 9 * * *"));
    }

    #[test]
    fn subdirectory_uses_nearest_configured_project() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("project");
        let child = parent.join("module");
        std::fs::create_dir_all(&child).unwrap();
        let yaml = format!(
            "name: existing\njob_type: job\nenabled: true\npath: ''\ncron: ''\nfolder_path: {}\ngroup: project\nslug: project/existing\n",
            parent.display()
        );
        let job: clawtab_lib::config::jobs::Job = serde_yml::from_str(&yaml).unwrap();
        let cwd = std::fs::canonicalize(&child).unwrap();
        let (root, group) = project_for_cwd(&[job.clone()], &cwd);
        assert_eq!(root, std::fs::canonicalize(parent).unwrap());
        assert_eq!(group, "project");

        let nested_yaml = format!(
            "name: existing\njob_type: job\nenabled: true\npath: ''\ncron: ''\nfolder_path: {}\ngroup: module\nslug: module/existing\n",
            child.display()
        );
        let nested = serde_yml::from_str(&nested_yaml).unwrap();
        let (root, group) = project_for_cwd(&[job, nested], &cwd);
        assert_eq!(root, cwd);
        assert_eq!(group, "module");
    }
}
