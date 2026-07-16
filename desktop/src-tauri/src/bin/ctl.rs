use std::env;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::process::Command;
use std::time::{Duration, Instant};

use clawtab_lib::config::jobs::JobStatus;
use clawtab_lib::ipc::{self, DesktopIpcCommand, IpcCommand, IpcResponse, PaneDirection};

/// Routes a parsed command to either the daemon or the desktop-app socket.
/// `cwtctl` originally only spoke to the daemon; UI actions like `pane focus`
/// and `open` live on the desktop socket so the daemon stays UI-agnostic.
enum Target {
    Daemon(IpcCommand),
    Desktop(DesktopIpcCommand),
}

fn print_usage() {
    eprintln!("cwtctl - CLI for ClawTab");
    eprintln!();
    eprintln!("Usage: cwtctl <command> [args]");
    eprintln!();
    eprintln!("Commands (require daemon):");
    eprintln!("  jobs              Manage configured jobs");
    eprintln!(
        "  usage <provider>  Show local provider quota usage (claude, codex, antigravity, zai)"
    );
    eprintln!("  secrets           List secret key names");
    eprintln!("  secrets get <k1> [k2 ...]  Get secret value (single key) or KEY=VALUE lines (multiple keys)");
    eprintln!("  secrets insert [--yes] <key> <value>  Store a secret; confirms before overwrite");
    eprintln!("  secrets delete [--yes] <key>          Delete a secret; confirms first");
    eprintln!("  telegram send <message>    Send a Telegram message via configured bot");
    eprintln!();
    eprintln!("Agent:");
    eprintln!("  agent auto-yes [toggle|check] [pane_id]  Manage auto-yes for an agent pane");
    eprintln!("  agent info [pane_id]                      Show agent session info");
    eprintln!("  agent info restore-command [pane_id]     Print an agent restore command");
    eprintln!("  agent rename <pane_id> <title>            Rename an agent pane");
    eprintln!("  agent ai-rename <pane_id>                  Generate a concise pane title");
    eprintln!();
    eprintln!("Pane (require desktop app):");
    eprintln!(
        "  pane open [pane_id]         Open tmux pane in ClawTab (uses $TMUX_PANE if omitted)"
    );
    eprintln!("  pane focus <left|right|up|down>  Move focus between ClawTab panes");
    eprintln!();
    eprintln!("Daemon:");
    eprintln!("  daemon install    Install launchd service (auto-start on login)");
    eprintln!("  daemon stop       Stop daemon but keep launchd service installed");
    eprintln!("  daemon uninstall  Remove launchd service");
    eprintln!("  daemon ping       Check if daemon is running");
    eprintln!("  daemon status     Check if daemon is running");
    eprintln!("  daemon restart    Restart the daemon");
    eprintln!("  daemon logs       Show daemon logs");
}

fn print_jobs_usage() {
    eprintln!("Usage: cwtctl jobs <command> [args]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  jobs list | ls             List jobs grouped by group");
    eprintln!("  jobs run <group>/<job>     Run a job and attach/follow its output");
    eprintln!("  jobs pause <group>/<job>   Pause a running job");
    eprintln!("  jobs resume <group>/<job>  Resume a paused job");
    eprintln!("  jobs restart <group>/<job> Restart a job");
    eprintln!("  jobs status                Show job statuses");
}

fn is_jobs_subcommand(command: &str) -> bool {
    matches!(
        command,
        "list" | "ls" | "run" | "pause" | "resume" | "restart" | "status"
    )
}

fn print_agent_usage() {
    eprintln!("Usage: cwtctl agent <command> [args]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  agent auto-yes [toggle|check] [pane_id]  Manage auto-yes for an agent pane");
    eprintln!("  agent info [pane_id]                      Show agent session info");
    eprintln!("  agent info restore-command [pane_id]     Print an agent restore command");
    eprintln!("  agent rename <pane_id> <title>            Rename an agent pane");
    eprintln!("  agent ai-rename <pane_id>                  Generate a concise pane title");
}

fn is_agent_subcommand(command: &str) -> bool {
    matches!(command, "auto-yes" | "info" | "rename" | "ai-rename")
}

fn require_job_reference(args: &[String], command: &str) -> String {
    match args.len() {
        3 => args[2].clone(),
        4 => format!("{}/{}", args[2], args[3]),
        _ => {
            eprintln!(
                "Usage: cwtctl {} <group>/<job> (or: cwtctl {} <group> <job>)",
                command, command
            );
            std::process::exit(1);
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let raw_args: Vec<String> = env::args().collect();

    if raw_args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    let jobs_scope = raw_args[1] == "jobs";
    let agent_scope = raw_args[1] == "agent";
    if jobs_scope {
        match raw_args.get(2).map(String::as_str) {
            None => {
                print_jobs_usage();
                std::process::exit(1);
            }
            Some("help" | "-h" | "--help") => {
                print_jobs_usage();
                std::process::exit(0);
            }
            Some(subcommand) if !is_jobs_subcommand(subcommand) => {
                eprintln!("Unknown jobs subcommand: {}", subcommand);
                print_jobs_usage();
                std::process::exit(1);
            }
            Some(_) => {}
        }
    }

    if agent_scope {
        match raw_args.get(2).map(String::as_str) {
            None => {
                print_agent_usage();
                std::process::exit(1);
            }
            Some("help" | "-h" | "--help") => {
                print_agent_usage();
                std::process::exit(0);
            }
            Some(subcommand) if !is_agent_subcommand(subcommand) => {
                eprintln!("Unknown agent subcommand: {}", subcommand);
                print_agent_usage();
                std::process::exit(1);
            }
            Some(_) => {}
        }
    }

    // Keep the existing command routing and positional argument handling by
    // removing the `jobs` namespace before dispatching its subcommand.
    let args = if jobs_scope || agent_scope {
        let mut normalized = Vec::with_capacity(raw_args.len() - 1);
        normalized.push(raw_args[0].clone());
        normalized.extend(raw_args[2..].iter().cloned());
        normalized
    } else {
        raw_args
    };

    let command = args[1].as_str();

    if matches!(command, "help" | "-h" | "--help") {
        print_usage();
        std::process::exit(0);
    }

    if !jobs_scope && is_jobs_subcommand(command) {
        eprintln!(
            "Job commands are under the jobs namespace: cwtctl jobs {}",
            command
        );
        std::process::exit(1);
    }

    if !agent_scope && matches!(command, "auto-yes" | "pane-info" | "rename" | "ai-rename") {
        eprintln!(
            "Agent commands are under the agent namespace: cwtctl agent {}",
            if command == "pane-info" {
                "info"
            } else {
                command
            }
        );
        std::process::exit(1);
    }

    if command == "open" {
        eprintln!("Pane commands are under the pane namespace: cwtctl pane open");
        std::process::exit(1);
    }

    // Handle daemon subcommands locally (no IPC needed)
    if command == "daemon" {
        handle_daemon_command(&args);
        return;
    }

    if command == "usage" {
        handle_usage_command(&args).await;
        return;
    }

    if command == "secrets" {
        handle_secrets_command(&args).await;
        return;
    }

    if command == "run" {
        run_job_command(&args, if jobs_scope { "cwtctl jobs" } else { "cwtctl" }).await;
        return;
    }

    let target = match command {
        "pane" => {
            let sub = args.get(2).map(String::as_str).unwrap_or("");
            match sub {
                "open" => {
                    let pane_id = if args.len() >= 4 {
                        args[3].clone()
                    } else {
                        env::var("TMUX_PANE").unwrap_or_else(|_| {
                            eprintln!(
                                "Error: not in a tmux pane (no $TMUX_PANE). Pass pane_id explicitly."
                            );
                            std::process::exit(1);
                        })
                    };
                    Target::Desktop(DesktopIpcCommand::OpenPane { pane_id })
                }
                "focus" => {
                    let dir_str = args.get(3).map(String::as_str).unwrap_or("");
                    let direction = match dir_str {
                        "left" => PaneDirection::Left,
                        "right" => PaneDirection::Right,
                        "up" => PaneDirection::Up,
                        "down" => PaneDirection::Down,
                        "" => {
                            eprintln!(
                                "Error: 'pane focus' requires a direction (left|right|up|down)"
                            );
                            std::process::exit(1);
                        }
                        other => {
                            eprintln!(
                                "Error: unknown direction '{}'. Expected left|right|up|down",
                                other
                            );
                            std::process::exit(1);
                        }
                    };
                    Target::Desktop(DesktopIpcCommand::FocusPane { direction })
                }
                "" => {
                    eprintln!("Error: 'pane' requires a subcommand (open|focus)");
                    std::process::exit(1);
                }
                other => {
                    eprintln!("Unknown 'pane' subcommand: {}", other);
                    std::process::exit(1);
                }
            }
        }
        "list" | "ls" => Target::Daemon(IpcCommand::ListJobs),
        "pause" => Target::Daemon(IpcCommand::PauseJob {
            name: require_job_reference(&args, "jobs pause"),
        }),
        "resume" => Target::Daemon(IpcCommand::ResumeJob {
            name: require_job_reference(&args, "jobs resume"),
        }),
        "restart" => Target::Daemon(IpcCommand::RestartJob {
            name: require_job_reference(&args, "jobs restart"),
        }),
        "status" => Target::Daemon(IpcCommand::GetStatus),
        "info" => {
            let restore_command = args.get(2).is_some_and(|arg| arg == "restore-command");
            let pane_arg_index = if restore_command { 3 } else { 2 };
            let pane_id = if args.len() > pane_arg_index {
                args[pane_arg_index].clone()
            } else {
                env::var("TMUX_PANE").unwrap_or_else(|_| {
                    eprintln!(
                        "Error: not in a tmux pane (no $TMUX_PANE). Pass pane_id explicitly."
                    );
                    std::process::exit(1);
                })
            };
            // Resolve locally - no IPC needed
            let pane_pid = resolve_tmux_pane_format(&pane_id, "#{pane_pid}");
            let pane_cwd = resolve_tmux_pane_format(&pane_id, "#{pane_current_path}");

            if pane_pid.is_empty() {
                eprintln!("Could not resolve pane PID");
                std::process::exit(1);
            }

            let snapshot = clawtab_lib::agent_session::ProcessSnapshot::capture();
            let provider =
                clawtab_lib::agent_session::detect_process_provider(&pane_pid, Some(&snapshot));
            let info = clawtab_lib::agent_session::resolve_session_info_for_provider_with_cwd(
                &pane_pid,
                provider,
                Some(&snapshot),
                if pane_cwd.is_empty() {
                    None
                } else {
                    Some(pane_cwd.as_str())
                },
            );
            if restore_command {
                match restore_command_for_provider(provider, info.session_id.as_deref()) {
                    Some(command) => println!("{}", command),
                    None => {
                        eprintln!("No restore command found");
                        std::process::exit(1);
                    }
                }
                return;
            }
            if let Some(ref session_id) = info.session_id {
                println!("session_id={}", session_id);
            }
            if let Some(ref date) = info.session_started_at {
                println!("started_at={}", date);
            }
            if let Some(epoch) = info.started_epoch {
                println!("started_epoch={}", epoch);
            }
            let settings = clawtab_lib::config::settings::AppSettings::load();
            let process_override = settings
                .process_overrides
                .get(&pane_id)
                .filter(|meta| meta.matches_identity(&pane_pid, info.session_id.as_deref()));
            let display_name = process_override.and_then(|meta| meta.display_name.as_ref());
            let first_query = process_override
                .and_then(|meta| meta.first_query.as_ref())
                .or(info.first_query.as_ref());
            let last_query = process_override
                .and_then(|meta| meta.last_query.as_ref())
                .or(info.last_query.as_ref());
            if let Some(name) = display_name {
                println!("display_name={}", name);
            }
            if let Some(query) = first_query {
                println!("first_query={}", query);
            }
            if let Some(query) = last_query {
                println!("last_query={}", query);
            }
            if info.session_started_at.is_none() && first_query.is_none() {
                eprintln!("No session info found");
                std::process::exit(1);
            }
            return;
        }
        "rename" => {
            if args.len() < 4 {
                eprintln!("Usage: cwtctl agent rename <pane_id> <title>");
                std::process::exit(1);
            }
            let pane_id = args[2].clone();
            let title = args[3..].join(" ");
            let display_name = if title.trim().is_empty() {
                None
            } else {
                Some(title.trim().to_string())
            };
            if let Err(error) = save_pane_display_name(&pane_id, display_name).await {
                eprintln!("Error: {}", error);
                std::process::exit(1);
            }
            println!("ok");
            return;
        }
        "ai-rename" => {
            if args.len() != 3 {
                eprintln!("Usage: cwtctl agent ai-rename <pane_id>");
                std::process::exit(1);
            }
            match generate_pane_title(&args[2]).await {
                Ok(title) => println!("{}", title),
                Err(error) => {
                    eprintln!("Error: {}", error);
                    std::process::exit(1);
                }
            }
            return;
        }
        "telegram" => {
            if args.len() >= 3 && args[2] == "send" {
                if args.len() < 4 {
                    eprintln!("Error: 'telegram send' requires a message");
                    std::process::exit(1);
                }
                let message = args[3..].join(" ");
                let settings = clawtab_lib::config::settings::AppSettings::load();
                let tg = match settings.telegram {
                    Some(ref t) if t.is_configured() => t,
                    _ => {
                        eprintln!("Error: Telegram not configured (no bot token or chat ids)");
                        std::process::exit(1);
                    }
                };
                let chat_id = tg.chat_ids[0];
                match clawtab_lib::telegram::send_message(&tg.bot_token, chat_id, &message).await {
                    Ok(()) => {
                        println!("ok");
                    }
                    Err(e) => {
                        eprintln!("Error: {}", e);
                        std::process::exit(1);
                    }
                }
                return;
            } else {
                eprintln!("Unknown telegram subcommand. Usage: telegram send <message>");
                std::process::exit(1);
            }
        }
        "auto-yes" => {
            if args.len() >= 3 && args[2] == "toggle" {
                let pane_id = if args.len() >= 4 {
                    args[3].clone()
                } else {
                    env::var("TMUX_PANE").unwrap_or_else(|_| {
                        eprintln!(
                            "Error: not in a tmux pane (no $TMUX_PANE). Pass pane_id explicitly."
                        );
                        std::process::exit(1);
                    })
                };
                Target::Daemon(IpcCommand::ToggleAutoYes { pane_id })
            } else if args.len() >= 3 && args[2] == "check" {
                // pane_id resolved later in check_pane
                Target::Daemon(IpcCommand::GetAutoYesPanes)
            } else {
                Target::Daemon(IpcCommand::GetAutoYesPanes)
            }
        }
        _ => {
            eprintln!("Unknown command: {}", command);
            print_usage();
            std::process::exit(1);
        }
    };

    // For auto-yes check, we need to know the pane_id to filter
    let check_pane = if command == "auto-yes" && args.len() >= 3 && args[2] == "check" {
        Some(if args.len() >= 4 {
            args[3].clone()
        } else {
            env::var("TMUX_PANE").unwrap_or_default()
        })
    } else {
        None
    };

    let response_result = match target {
        Target::Daemon(cmd) => ipc::send_command(cmd).await,
        Target::Desktop(cmd) => ipc::send_desktop_command(cmd).await,
    };

    match response_result {
        Ok(response) => match response {
            IpcResponse::Pong => {
                println!("pong");
            }
            IpcResponse::Ok => {
                println!("ok");
            }
            IpcResponse::Jobs(jobs) => {
                if jobs.is_empty() {
                    println!("No jobs configured");
                } else {
                    let mut current_group: Option<String> = None;
                    for job in jobs {
                        if current_group.as_deref() != Some(job.group.as_str()) {
                            if current_group.is_some() {
                                println!();
                            }
                            println!("{}", job.group);
                            current_group = Some(job.group.clone());
                        }
                        println!("  {}", job.name);
                    }
                }
            }
            IpcResponse::Status(statuses) => {
                if statuses.is_empty() {
                    println!("No job statuses");
                } else {
                    let mut names: Vec<&String> = statuses.keys().collect();
                    names.sort();
                    for name in names {
                        let status = &statuses[name];
                        let state = serde_json::to_string(status).unwrap_or_default();
                        println!("{}: {}", name, state);
                    }
                }
            }
            IpcResponse::SecretKeys(keys) => {
                if keys.is_empty() {
                    println!("No secrets stored");
                } else {
                    for key in keys {
                        println!("{}", key);
                    }
                }
            }
            IpcResponse::SecretValues(pairs) => {
                if pairs.len() == 1 {
                    println!("{}", pairs[0].1);
                } else {
                    for (k, v) in pairs {
                        println!("{}={}", k, v);
                    }
                }
            }
            IpcResponse::PaneInfo {
                first_query,
                last_query,
                session_started_at,
            } => {
                if let Some(ref date) = session_started_at {
                    println!("started_at={}", date);
                }
                if let Some(ref query) = first_query {
                    println!("first_query={}", query);
                }
                if let Some(ref query) = last_query {
                    println!("last_query={}", query);
                }
                if session_started_at.is_none() && first_query.is_none() {
                    eprintln!("No session info found");
                    std::process::exit(1);
                }
            }
            IpcResponse::AutoYesPanes(panes) => {
                if let Some(check) = check_pane {
                    if panes.contains(&check) {
                        println!("on");
                        std::process::exit(0);
                    } else {
                        println!("off");
                        std::process::exit(1);
                    }
                } else if panes.is_empty() {
                    println!("No auto-yes panes");
                } else {
                    for pane in panes {
                        println!("{}", pane);
                    }
                }
            }
            IpcResponse::ActiveQuestions(qs) => {
                if qs.is_empty() {
                    println!("No active questions");
                } else {
                    for q in qs {
                        println!("{}: {}", q.pane_id, q.context_lines);
                    }
                }
            }
            IpcResponse::ProviderUsage(usage) => print_provider_usage(usage),
            IpcResponse::AgentActivity(_) => {
                eprintln!("Error: agent activity is available through the tmux IPC integration");
                std::process::exit(1);
            }
            IpcResponse::RelayStatus(status) => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&status).unwrap_or_default()
                );
            }
            IpcResponse::PaneCreated {
                pane_id,
                tmux_session,
            } => {
                println!(
                    "pane={} session={}",
                    pane_id.as_deref().unwrap_or("-"),
                    tmux_session.as_deref().unwrap_or("-")
                );
            }
            IpcResponse::RunStarted { .. } => {
                eprintln!("Error: unexpected run-start response");
                std::process::exit(1);
            }
            IpcResponse::AllPanes(panes) => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&panes).unwrap_or_default()
                );
            }
            IpcResponse::Error(msg) => {
                eprintln!("Error: {}", msg);
                std::process::exit(1);
            }
        },
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    }
}

async fn run_job_command(args: &[String], command_prefix: &str) {
    let reference = parse_run_reference(args, command_prefix);
    let response = ipc::send_command(IpcCommand::RunJobCli {
        name: reference.clone(),
    })
    .await;

    match response {
        Ok(IpcResponse::RunStarted {
            slug,
            run_id,
            is_binary,
        }) => follow_started_job(&reference, &slug, &run_id, is_binary).await,
        Ok(IpcResponse::Error(error)) => exit_error(&error),
        Ok(response) => exit_error(&format!("unexpected response from daemon: {:?}", response)),
        Err(error) => exit_error(&error),
    }
}

fn parse_run_reference(args: &[String], command_prefix: &str) -> String {
    match args.len() {
        3 => args[2].clone(),
        4 => format!("{}/{}", args[2], args[3]),
        _ => {
            let usage = format!(
                "usage: {} run <group>/<job> (or: {} run <group> <job>)",
                command_prefix, command_prefix
            );
            exit_error(&usage)
        }
    }
}

async fn follow_started_job(reference: &str, slug: &str, run_id: &str, is_binary: bool) {
    // Binary jobs are followed until they finish. Agent jobs only need a
    // bounded wait for the daemon to publish their tmux pane.
    let deadline = (!is_binary).then(|| Instant::now() + Duration::from_secs(10));
    let mut log_offset = 0_u64;
    let log_path = is_binary.then(|| binary_log_path(slug, run_id));
    let mut saw_running = false;
    if is_binary {
        println!("{} (binary logs):", reference);
        let _ = io::stdout().flush();
    }

    loop {
        let status = match get_job_status(slug).await {
            Ok(status) => status,
            Err(error) => exit_error(&error),
        };

        match status.as_ref() {
            Some(JobStatus::Running {
                run_id: current_run,
                pane_id: Some(pane_id),
                tmux_session: Some(tmux_session),
                ..
            }) => {
                if current_run != run_id {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
                // A pane may take a moment to be published when the daemon
                // was busy. Attach as soon as it becomes available.
                saw_running = true;
                if !is_binary {
                    if let Err(error) = attach_to_tmux(tmux_session, pane_id) {
                        exit_error(&error);
                    }
                    return;
                }
            }
            Some(JobStatus::Running {
                run_id: current_run,
                ..
            }) => {
                if current_run == run_id {
                    saw_running = true;
                }
            }
            Some(JobStatus::Success { .. }) | Some(JobStatus::Failed { .. }) => {
                if let Some(path) = log_path.as_ref() {
                    let (chunk, _) = read_log_chunk(path, log_offset);
                    if !chunk.is_empty() {
                        print!("{}", chunk);
                        let _ = io::stdout().flush();
                    }
                    if path.exists() || saw_running {
                        print_terminal_status(status.as_ref().expect("terminal status is present"));
                        return;
                    }
                } else if saw_running {
                    print_terminal_status(status.as_ref().expect("terminal status is present"));
                    return;
                }
            }
            Some(JobStatus::Idle) | Some(JobStatus::Paused) | None => {}
        }

        if let Some(path) = log_path.as_ref() {
            let (chunk, next_offset) = read_log_chunk(path, log_offset);
            if !chunk.is_empty() {
                print!("{}", chunk);
                let _ = io::stdout().flush();
            }
            log_offset = next_offset;
        }

        if deadline.is_some_and(|limit| Instant::now() >= limit) {
            exit_error("job started but no pane or binary log became available");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn get_job_status(slug: &str) -> Result<Option<JobStatus>, String> {
    match ipc::send_command(IpcCommand::GetStatus).await? {
        IpcResponse::Status(statuses) => Ok(statuses.get(slug).cloned()),
        response => Err(format!("unexpected response from daemon: {:?}", response)),
    }
}

fn binary_log_path(slug: &str, run_id: &str) -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".config")
        .join("clawtab")
        .join("jobs")
        .join(slug)
        .join("logs")
        .join(format!("{}.log", run_id))
}

fn read_log_chunk(path: &std::path::Path, offset: u64) -> (String, u64) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return (String::new(), offset);
    };
    let start = if offset > metadata.len() { 0 } else { offset };
    let Ok(mut file) = std::fs::File::open(path) else {
        return (String::new(), start);
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (String::new(), start);
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return (String::new(), start);
    }
    let next_offset = start.saturating_add(bytes.len() as u64);
    (String::from_utf8_lossy(&bytes).into_owned(), next_offset)
}

fn print_terminal_status(status: &JobStatus) {
    match status {
        JobStatus::Success { .. } => println!("Finished: success"),
        JobStatus::Failed { exit_code, .. } => {
            println!("Finished: failed (exit code {})", exit_code)
        }
        _ => {}
    }
}

fn attach_to_tmux(session: &str, pane: &str) -> Result<(), String> {
    if env::var_os("TMUX").is_some() {
        let status = Command::new("tmux")
            .args(["switch-client", "-t", session])
            .status()
            .map_err(|error| format!("failed to switch to tmux session: {}", error))?;
        if !status.success() {
            return Err(format!("tmux switch-client exited with {}", status));
        }
        let status = Command::new("tmux")
            .args(["select-pane", "-t", pane])
            .status()
            .map_err(|error| format!("failed to select tmux pane: {}", error))?;
        if !status.success() {
            return Err(format!("tmux select-pane exited with {}", status));
        }
        return Ok(());
    }

    let select = Command::new("tmux")
        .args(["select-pane", "-t", pane])
        .status()
        .map_err(|error| format!("failed to select tmux pane: {}", error))?;
    if !select.success() {
        return Err(format!("tmux select-pane exited with {}", select));
    }
    let status = Command::new("tmux")
        .args(["attach-session", "-t", session])
        .status()
        .map_err(|error| format!("failed to attach to tmux session: {}", error))?;
    if !status.success() {
        return Err(format!("tmux attach-session exited with {}", status));
    }
    Ok(())
}

async fn handle_usage_command(args: &[String]) {
    let provider = args.get(2).cloned().unwrap_or_else(|| {
        eprintln!("Error: 'usage' requires a provider (claude, codex, antigravity, or zai)");
        std::process::exit(1);
    });
    let zai_token = if provider.eq_ignore_ascii_case("zai") || provider.eq_ignore_ascii_case("z.ai")
    {
        let explicit_tokens = {
            let secrets = clawtab_lib::secrets::SecretsManager::new();
            clawtab_lib::usage::ZAI_TOKEN_KEYS
                .iter()
                .map(|key| secrets.get(key).cloned())
                .collect()
        };
        clawtab_lib::usage::resolve_zai_token_from_sources(explicit_tokens)
    } else {
        None
    };

    match clawtab_lib::usage::fetch_provider_usage(&provider, zai_token).await {
        Ok(usage) => print_provider_usage(usage),
        Err(error) => exit_error(&error),
    }
}

fn print_provider_usage(usage: clawtab_lib::usage::ProviderUsageSnapshot) {
    if usage.status == "unavailable" {
        if let Some(note) = usage.note.as_deref() {
            eprintln!("usage detail: {}", note);
        }
    }
    println!("provider={}", usage.provider);
    println!("status={}", usage.status);
    println!("summary={}", usage.summary);
    for entry in usage.entries {
        let key = entry.label.to_ascii_lowercase().replace(' ', "_");
        println!("{}={}", key, entry.value);
    }
}

async fn handle_secrets_command(args: &[String]) {
    let subcommand = args.get(2).map(String::as_str);

    match subcommand {
        None => match ipc::send_command(IpcCommand::ListSecretKeys).await {
            Ok(IpcResponse::SecretKeys(keys)) => print_secret_keys(keys),
            Ok(IpcResponse::Error(msg)) => exit_error(&msg),
            Ok(_) => exit_error("unexpected response from daemon"),
            Err(e) => exit_error(&e),
        },
        Some("get") => {
            if args.len() < 4 {
                exit_error("'secrets get' requires at least one key");
            }
            match ipc::send_command(IpcCommand::GetSecretValues {
                keys: args[3..].to_vec(),
            })
            .await
            {
                Ok(IpcResponse::SecretValues(pairs)) => print_secret_values(pairs),
                Ok(IpcResponse::Error(msg)) => exit_error(&msg),
                Ok(_) => exit_error("unexpected response from daemon"),
                Err(e) => exit_error(&e),
            }
        }
        Some("insert") => {
            let (yes, positionals) = parse_secret_args(&args[3..]);
            if positionals.len() != 2 {
                exit_error("usage: cwtctl secrets insert [--yes] <key> <value>");
            }
            let key = positionals[0].clone();
            let value = positionals[1].clone();
            if key.trim().is_empty() {
                exit_error("secret key cannot be empty");
            }

            if secret_exists(&key).await && !yes {
                confirm_or_exit(&format!("Overwrite secret '{}'", key), &key);
            }

            match ipc::send_command(IpcCommand::SetSecret {
                key: key.clone(),
                value,
            })
            .await
            {
                Ok(IpcResponse::Ok) => println!("Stored secret '{}'", key),
                Ok(IpcResponse::Error(msg)) => exit_error(&msg),
                Ok(_) => exit_error("unexpected response from daemon"),
                Err(e) => exit_error(&e),
            }
        }
        Some("delete") => {
            let (yes, positionals) = parse_secret_args(&args[3..]);
            if positionals.len() != 1 {
                exit_error("usage: cwtctl secrets delete [--yes] <key>");
            }
            let key = positionals[0].clone();
            if key.trim().is_empty() {
                exit_error("secret key cannot be empty");
            }

            if !yes {
                confirm_or_exit(&format!("Delete secret '{}'", key), &key);
            }

            match ipc::send_command(IpcCommand::DeleteSecret { key: key.clone() }).await {
                Ok(IpcResponse::Ok) => println!("Deleted secret '{}'", key),
                Ok(IpcResponse::Error(msg)) => exit_error(&msg),
                Ok(_) => exit_error("unexpected response from daemon"),
                Err(e) => exit_error(&e),
            }
        }
        Some(other) => {
            eprintln!("Unknown secrets subcommand: {}", other);
            eprintln!("Usage: cwtctl secrets [get|insert|delete] ...");
            std::process::exit(1);
        }
    }
}

fn parse_secret_args(args: &[String]) -> (bool, Vec<String>) {
    let mut yes = false;
    let mut positionals = Vec::new();
    for arg in args {
        if arg == "--yes" || arg == "-y" {
            yes = true;
        } else {
            positionals.push(arg.clone());
        }
    }
    (yes, positionals)
}

async fn secret_exists(key: &str) -> bool {
    match ipc::send_command(IpcCommand::ListSecretKeys).await {
        Ok(IpcResponse::SecretKeys(keys)) => keys.iter().any(|existing| existing == key),
        Ok(IpcResponse::Error(msg)) => exit_error(&msg),
        Ok(_) => exit_error("unexpected response from daemon"),
        Err(e) => exit_error(&e),
    }
}

fn confirm_or_exit(action: &str, key: &str) {
    eprint!("{}. Type '{}' to confirm: ", action, key);
    let _ = io::stderr().flush();

    let mut input = String::new();
    if let Err(e) = io::stdin().read_line(&mut input) {
        exit_error(&format!("failed to read confirmation: {}", e));
    }

    if input.trim_end() != key {
        eprintln!("Aborted");
        std::process::exit(1);
    }
}

fn print_secret_keys(keys: Vec<String>) {
    if keys.is_empty() {
        println!("No secrets stored");
    } else {
        for key in keys {
            println!("{}", key);
        }
    }
}

fn print_secret_values(pairs: Vec<(String, String)>) {
    if pairs.len() == 1 {
        println!("{}", pairs[0].1);
    } else {
        for (k, v) in pairs {
            println!("{}={}", k, v);
        }
    }
}

fn exit_error(msg: &str) -> ! {
    eprintln!("Error: {}", msg);
    std::process::exit(1);
}

async fn save_pane_display_name(pane_id: &str, display_name: Option<String>) -> Result<(), String> {
    let title = display_name.as_deref().unwrap_or("");
    let pane_title_output = std::process::Command::new("tmux")
        .args(["select-pane", "-t", pane_id, "-T", title])
        .output()
        .map_err(|error| format!("failed to set tmux pane title: {}", error))?;
    if !pane_title_output.status.success() {
        return Err(format!(
            "failed to set tmux pane title: {}",
            String::from_utf8_lossy(&pane_title_output.stderr).trim()
        ));
    }

    let mut option_command = std::process::Command::new("tmux");
    option_command.args(["set-option", "-p", "-t", pane_id]);
    if display_name.is_some() {
        option_command.args(["@clawtab-display-name", title]);
    } else {
        option_command.args(["-u", "@clawtab-display-name"]);
    }
    let option_output = option_command
        .output()
        .map_err(|error| format!("failed to persist tmux pane title: {}", error))?;
    if !option_output.status.success() {
        return Err(format!(
            "failed to persist tmux pane title: {}",
            String::from_utf8_lossy(&option_output.stderr).trim()
        ));
    }

    match ipc::send_desktop_command(DesktopIpcCommand::RenamePane {
        pane_id: pane_id.to_string(),
        display_name: display_name.clone(),
    })
    .await
    {
        Ok(IpcResponse::Ok) => return Ok(()),
        Ok(IpcResponse::Error(error)) => return Err(error),
        Ok(response) => return Err(format!("unexpected desktop response: {:?}", response)),
        Err(_) => {}
    }

    let mut settings = clawtab_lib::config::settings::AppSettings::load();
    let entry = settings
        .process_overrides
        .entry(pane_id.to_string())
        .or_default();
    entry.display_name = display_name;
    if entry.display_name.is_some() {
        let pane_pid = resolve_tmux_pane_format(pane_id, "#{pane_pid}");
        let pane_cwd = resolve_tmux_pane_format(pane_id, "#{pane_current_path}");
        if !pane_pid.is_empty() {
            let snapshot = clawtab_lib::agent_session::ProcessSnapshot::capture();
            let provider =
                clawtab_lib::agent_session::detect_process_provider(&pane_pid, Some(&snapshot));
            let session_id =
                clawtab_lib::agent_session::resolve_session_info_for_provider_with_cwd(
                    &pane_pid,
                    provider,
                    Some(&snapshot),
                    (!pane_cwd.is_empty()).then_some(pane_cwd.as_str()),
                )
                .session_id;
            entry.set_identity(pane_pid, session_id);
        }
    }
    if entry.display_name.is_none()
        && entry.first_query.is_none()
        && entry.last_query.is_none()
        && entry.group_override.is_none()
    {
        settings.process_overrides.remove(pane_id);
    }
    settings.save()
}

async fn generate_pane_title(pane_id: &str) -> Result<String, String> {
    use clawtab_lib::agent_session::{ProcessProvider, ProcessSnapshot};

    let pane_pid = resolve_tmux_pane_format(pane_id, "#{pane_pid}");
    let pane_cwd = resolve_tmux_pane_format(pane_id, "#{pane_current_path}");
    if pane_pid.is_empty() {
        return Err("could not resolve pane PID".to_string());
    }

    let snapshot = ProcessSnapshot::capture();
    let detected_provider =
        clawtab_lib::agent_session::detect_process_provider(&pane_pid, Some(&snapshot));
    let info = clawtab_lib::agent_session::resolve_session_info_for_provider_with_cwd(
        &pane_pid,
        detected_provider,
        Some(&snapshot),
        (!pane_cwd.is_empty()).then_some(pane_cwd.as_str()),
    );
    let settings = clawtab_lib::config::settings::AppSettings::load();
    let process_override = settings.process_overrides.get(pane_id);
    let first_query = process_override
        .and_then(|meta| meta.first_query.as_ref())
        .or(info.first_query.as_ref());
    let last_query = process_override
        .and_then(|meta| meta.last_query.as_ref())
        .or(info.last_query.as_ref());
    if first_query.is_none() && last_query.is_none() {
        return Err("no agent queries found for this pane".to_string());
    }

    let mut provider = settings
        .title_summary_provider
        .or(detected_provider)
        .unwrap_or(settings.default_provider);
    if provider == ProcessProvider::Shell {
        provider = settings.default_provider;
    }
    if provider == ProcessProvider::Shell {
        return Err("configure a non-shell AI pane-title provider".to_string());
    }

    let model = settings
        .title_summary_model
        .clone()
        .or_else(|| {
            let models = settings.enabled_models.get(provider.as_str())?;
            models.get(models.len() / 2).cloned()
        })
        .or_else(|| {
            (provider == settings.default_provider)
                .then(|| settings.default_model.clone())
                .flatten()
        });

    let context_limit = 6_000;
    let compact_context = |text: &str| -> String {
        let mut value = text.chars().take(context_limit).collect::<String>();
        if text.chars().count() > context_limit {
            value.push_str("...");
        }
        value
    };
    let first = first_query.map(|value| compact_context(value));
    let last = last_query.map(|value| compact_context(value));
    let mut prompt = String::from(
        "Create a concise title that summarizes this coding agent's objective. \
Return only the title, with no quotes, markdown, explanation, or ending punctuation. \
Use 3 to 8 words and at most 60 characters. Prefer the durable objective over the latest tactical step. \
Do not use tools.\n\n",
    );
    if let Some(first) = first.as_ref() {
        prompt.push_str("First query:\n");
        prompt.push_str(first);
        prompt.push_str("\n\n");
    }
    if let Some(last) = last.as_ref().filter(|last| Some(*last) != first.as_ref()) {
        prompt.push_str("Latest query:\n");
        prompt.push_str(last);
        prompt.push('\n');
    }

    let binary = match provider {
        ProcessProvider::Claude => settings.claude_path.clone(),
        _ => settings
            .tool_paths
            .get(provider.binary_name())
            .cloned()
            .unwrap_or_else(|| provider.binary_name().to_string()),
    };
    let mut command = tokio::process::Command::new(binary);
    command
        .kill_on_drop(true)
        .current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    match provider {
        ProcessProvider::Claude => {
            command.arg("-p");
            if let Some(model) = model.as_ref() {
                command.args(["--model", model]);
            }
            command.arg(&prompt);
        }
        ProcessProvider::Codex => {
            command.args([
                "exec",
                "--ephemeral",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
            ]);
            if let Some(model) = model.as_ref() {
                command.args(["--model", model]);
            }
            command.arg(&prompt);
        }
        ProcessProvider::Opencode => {
            command.arg("run");
            if let Some(model) = model.as_ref() {
                command.args(["--model", model]);
            }
            command.arg(&prompt);
        }
        ProcessProvider::Antigravity => {
            command.arg("-p");
            if let Some(model) = model.as_ref() {
                command.args(["--model", model]);
            }
            command.arg(&prompt);
        }
        ProcessProvider::Shell => unreachable!(),
    }

    let output = tokio::time::timeout(Duration::from_secs(45), command.output())
        .await
        .map_err(|_| "pane-title generation timed out after 45 seconds".to_string())?
        .map_err(|error| format!("failed to start {}: {}", provider.as_str(), error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("");
        return Err(format!(
            "{} title generation failed: {}",
            provider.as_str(),
            detail
        ));
    }

    let clean = clawtab_lib::telegram::strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let raw_title = clean
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| format!("{} returned an empty title", provider.as_str()))?;
    let raw_title = raw_title
        .strip_prefix("Title:")
        .unwrap_or(raw_title)
        .trim()
        .trim_matches(|character| matches!(character, '`' | '"' | '\''));
    let mut title = raw_title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.chars().count() > 60 {
        title = title.chars().take(57).collect::<String>();
        title.push_str("...");
    }
    if title.is_empty() {
        return Err(format!("{} returned an empty title", provider.as_str()));
    }
    save_pane_display_name(pane_id, Some(title.clone())).await?;
    Ok(title)
}

fn resolve_tmux_pane_format(pane_id: &str, format: &str) -> String {
    let list_format = format!("#{{pane_id}}\x1e{}", format);
    let from_list_panes = std::process::Command::new("tmux")
        .args(["list-panes", "-a", "-F", &list_format])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout).lines().find_map(|line| {
                let (id, value) = line.split_once('\x1e')?;
                (id == pane_id).then(|| value.trim().to_string())
            })
        })
        .unwrap_or_default();

    if !from_list_panes.is_empty() {
        return from_list_panes;
    }

    std::process::Command::new("tmux")
        .args(["display-message", "-p", "-t", pane_id, format])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn restore_command_for_provider(
    provider: Option<clawtab_lib::agent_session::ProcessProvider>,
    session_id: Option<&str>,
) -> Option<String> {
    let session_id = session_id?;
    match provider? {
        clawtab_lib::agent_session::ProcessProvider::Claude => {
            Some(format!("claude -r {}", session_id))
        }
        clawtab_lib::agent_session::ProcessProvider::Codex => {
            Some(format!("codex resume {}", session_id))
        }
        clawtab_lib::agent_session::ProcessProvider::Opencode => {
            Some(format!("opencode -s {}", session_id))
        }
        clawtab_lib::agent_session::ProcessProvider::Antigravity => {
            Some(format!("agy --conversation {}", session_id))
        }
        clawtab_lib::agent_session::ProcessProvider::Shell => None,
    }
}

use clawtab_lib::daemon;

fn handle_daemon_command(args: &[String]) {
    let sub = if args.len() >= 3 {
        args[2].as_str()
    } else {
        ""
    };
    match sub {
        "install" => daemon_install(),
        "stop" => daemon_stop(),
        "uninstall" => daemon_uninstall(),
        "ping" => daemon_ping(),
        "status" => daemon_status(),
        "restart" => daemon_restart(),
        "logs" => daemon_logs(),
        _ => {
            eprintln!("Usage: cwtctl daemon <install|stop|uninstall|ping|status|restart|logs>");
            std::process::exit(1);
        }
    }
}

fn daemon_install() {
    match daemon::install() {
        Ok(msg) => println!("{}", msg),
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    }
}

fn daemon_stop() {
    match daemon::stop() {
        Ok(msg) => println!("{}", msg),
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    }
}

fn daemon_uninstall() {
    match daemon::uninstall() {
        Ok(msg) => println!("{}", msg),
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    }
}

fn daemon_ping() {
    let (running, _) = daemon::is_running();
    if running {
        println!("pong");
    } else {
        eprintln!("Error: daemon is not running");
        std::process::exit(1);
    }
}

fn daemon_status() {
    let installed = daemon::is_installed();
    let (running, pid) = daemon::is_running();

    if running {
        println!(
            "Daemon: running (pid {})",
            pid.map_or("-".to_string(), |p| p.to_string())
        );
    } else if installed {
        println!("Daemon: installed but not running");
    } else {
        println!("Daemon: not installed");
    }
}

fn daemon_restart() {
    let uid = std::process::Command::new("id")
        .args(["-u"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .parse::<u32>()
                    .ok()
            } else {
                None
            }
        })
        .unwrap_or(501);

    let service = format!("gui/{}/{}", uid, daemon::PLIST_LABEL);
    let status = std::process::Command::new("launchctl")
        .args(["kickstart", "-k", &service])
        .status();

    match status {
        Ok(s) if s.success() => println!("Daemon restarted"),
        Ok(s) => {
            eprintln!("launchctl kickstart exited with {}", s);
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("Failed to run launchctl: {}", e);
            std::process::exit(1);
        }
    }
}

fn daemon_logs() {
    let stderr_log = "/tmp/clawtab/daemon.stderr.log";
    if std::path::Path::new(stderr_log).exists() {
        let _ = std::process::Command::new("tail")
            .args(["-50", stderr_log])
            .status();
    } else {
        eprintln!("No daemon log found at {}", stderr_log);
    }
}
