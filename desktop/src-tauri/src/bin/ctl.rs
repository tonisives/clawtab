use std::env;
use std::io::{self, Write};

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
    eprintln!("  ping              Check if ClawTab daemon is running");
    eprintln!("  list | ls         List all jobs");
    eprintln!("  run <name>        Run a job by name");
    eprintln!("  pause <name>      Pause a running job");
    eprintln!("  resume <name>     Resume a paused job");
    eprintln!("  restart <name>    Restart a job");
    eprintln!("  status            Show job statuses");
    eprintln!("  auto-yes          Show auto-yes panes");
    eprintln!("  auto-yes toggle [pane_id]  Toggle auto-yes for pane (uses $TMUX_PANE if omitted)");
    eprintln!("  auto-yes check [pane_id]   Check if pane has auto-yes (exit 0=on, 1=off)");
    eprintln!("  pane-info [pane_id]        Show first query and session date for an agent pane");
    eprintln!("  pane-info restore-command [pane_id]  Print a restore command for an agent pane");
    eprintln!("  secrets           List secret key names");
    eprintln!("  secrets get <k1> [k2 ...]  Get secret value (single key) or KEY=VALUE lines (multiple keys)");
    eprintln!("  secrets insert [--yes] <key> <value>  Store a secret; confirms before overwrite");
    eprintln!("  secrets delete [--yes] <key>          Delete a secret; confirms first");
    eprintln!("  telegram send <message>    Send a Telegram message via configured bot");
    eprintln!();
    eprintln!("Pane (require desktop app):");
    eprintln!(
        "  open [pane_id]              Open tmux pane in ClawTab (uses $TMUX_PANE if omitted)"
    );
    eprintln!("  pane focus <left|right|up|down>  Move focus between ClawTab panes");
    eprintln!();
    eprintln!("Daemon:");
    eprintln!("  daemon install    Install launchd service (auto-start on login)");
    eprintln!("  daemon uninstall  Remove launchd service");
    eprintln!("  daemon status     Check if daemon is running");
    eprintln!("  daemon restart    Restart the daemon");
    eprintln!("  daemon logs       Show daemon logs");
}

fn require_name(args: &[String], cmd_name: &str) -> String {
    if args.len() < 3 {
        eprintln!("Error: '{}' requires a job name", cmd_name);
        std::process::exit(1);
    }
    args[2].clone()
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    let command = args[1].as_str();

    if matches!(command, "help" | "-h" | "--help") {
        print_usage();
        std::process::exit(0);
    }

    // Handle daemon subcommands locally (no IPC needed)
    if command == "daemon" {
        handle_daemon_command(&args);
        return;
    }

    if command == "secrets" {
        handle_secrets_command(&args).await;
        return;
    }

    let target = match command {
        "open" => {
            let pane_id = if args.len() >= 3 {
                args[2].clone()
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
        "pane" => {
            let sub = args.get(2).map(String::as_str).unwrap_or("");
            match sub {
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
                    eprintln!("Error: 'pane' requires a subcommand (focus)");
                    std::process::exit(1);
                }
                other => {
                    eprintln!("Unknown 'pane' subcommand: {}", other);
                    std::process::exit(1);
                }
            }
        }
        "ping" => Target::Daemon(IpcCommand::Ping),
        "list" | "ls" => Target::Daemon(IpcCommand::ListJobs),
        "run" => Target::Daemon(IpcCommand::RunJob {
            name: require_name(&args, "run"),
        }),
        "pause" => Target::Daemon(IpcCommand::PauseJob {
            name: require_name(&args, "pause"),
        }),
        "resume" => Target::Daemon(IpcCommand::ResumeJob {
            name: require_name(&args, "resume"),
        }),
        "restart" => Target::Daemon(IpcCommand::RestartJob {
            name: require_name(&args, "restart"),
        }),
        "status" => Target::Daemon(IpcCommand::GetStatus),
        "pane-info" => {
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
            if let Some(ref query) = info.first_query {
                println!("first_query={}", query);
            }
            if let Some(ref query) = info.last_query {
                println!("last_query={}", query);
            }
            if info.session_started_at.is_none() && info.first_query.is_none() {
                eprintln!("No session info found");
                std::process::exit(1);
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
                    for job in jobs {
                        println!("{}", job);
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
        "uninstall" => daemon_uninstall(),
        "status" => daemon_status(),
        "restart" => daemon_restart(),
        "logs" => daemon_logs(),
        _ => {
            eprintln!("Usage: cwtctl daemon <install|uninstall|status|restart|logs>");
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

fn daemon_uninstall() {
    match daemon::uninstall() {
        Ok(msg) => println!("{}", msg),
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
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
