use std::env;

use clawtab_lib::ipc::{self, IpcCommand, IpcResponse};

fn print_usage() {
    eprintln!("cwtctl - CLI for ClawTab");
    eprintln!();
    eprintln!("Usage: cwtctl <command> [args]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  ping              Check if ClawTab is running");
    eprintln!("  list | ls         List all jobs");
    eprintln!("  run <name>        Run a job by name");
    eprintln!("  pause <name>      Pause a running job");
    eprintln!("  resume <name>     Resume a paused job");
    eprintln!("  restart <name>    Restart a job");
    eprintln!("  status            Show job statuses");
    eprintln!("  open [pane_id]    Open current tmux pane in ClawTab (uses $TMUX_PANE if omitted)");
    eprintln!("  auto-yes          Show auto-yes panes");
    eprintln!("  auto-yes toggle [pane_id]  Toggle auto-yes for pane (uses $TMUX_PANE if omitted)");
    eprintln!("  auto-yes check [pane_id]   Check if pane has auto-yes (exit 0=on, 1=off)");
    eprintln!("  pane-info [pane_id]        Show first query and session date for a Claude pane");
    eprintln!("  secrets           List secret key names");
    eprintln!("  secrets get <k1> [k2 ...]  Get secret values as KEY=VALUE lines");
    eprintln!("  telegram send <message>    Send a Telegram message via configured bot");
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

    let ipc_cmd = match command {
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
            IpcCommand::OpenPane { pane_id }
        }
        "ping" => IpcCommand::Ping,
        "list" | "ls" => IpcCommand::ListJobs,
        "run" => IpcCommand::RunJob {
            name: require_name(&args, "run"),
        },
        "pause" => IpcCommand::PauseJob {
            name: require_name(&args, "pause"),
        },
        "resume" => IpcCommand::ResumeJob {
            name: require_name(&args, "resume"),
        },
        "restart" => IpcCommand::RestartJob {
            name: require_name(&args, "restart"),
        },
        "status" => IpcCommand::GetStatus,
        "secrets" => {
            if args.len() >= 3 && args[2] == "get" {
                if args.len() < 4 {
                    eprintln!("Error: 'secrets get' requires at least one key");
                    std::process::exit(1);
                }
                IpcCommand::GetSecretValues {
                    keys: args[3..].to_vec(),
                }
            } else {
                IpcCommand::ListSecretKeys
            }
        }
        "pane-info" => {
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
            // Resolve locally - no IPC needed
            let pane_pid = std::process::Command::new("tmux")
                .args(["list-panes", "-t", &pane_id, "-F", "#{pane_id} #{pane_pid}"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                        stdout
                            .lines()
                            .find(|l| l.starts_with(&format!("{} ", pane_id)))
                            .and_then(|l| l.split_whitespace().nth(1))
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();

            if pane_pid.is_empty() {
                eprintln!("Could not resolve pane PID");
                std::process::exit(1);
            }

            let info = clawtab_lib::agent_session::resolve_session_info(&pane_pid);
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
                IpcCommand::ToggleAutoYes { pane_id }
            } else if args.len() >= 3 && args[2] == "check" {
                // pane_id resolved later in check_pane
                IpcCommand::GetAutoYesPanes
            } else {
                IpcCommand::GetAutoYesPanes
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

    match ipc::send_command(ipc_cmd).await {
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
                for (k, v) in pairs {
                    println!("{}={}", k, v);
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

const PLIST_LABEL: &str = "com.clawtab.daemon";

fn plist_dest() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", PLIST_LABEL))
}

fn handle_daemon_command(args: &[String]) {
    let sub = if args.len() >= 3 { args[2].as_str() } else { "" };
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
    let dest = plist_dest();
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Ensure log directory exists
    let _ = std::fs::create_dir_all("/tmp/clawtab");

    // Check that the binary exists
    if !std::path::Path::new("/usr/local/bin/clawtab-daemon").exists() {
        eprintln!("Error: /usr/local/bin/clawtab-daemon not found");
        eprintln!("Run 'make build-daemon' first");
        std::process::exit(1);
    }

    // Embedded plist content
    let plist = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clawtab.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/clawtab-daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/clawtab/daemon.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/clawtab/daemon.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>RUST_LOG</key>
        <string>info</string>
    </dict>
</dict>
</plist>"#;

    if let Err(e) = std::fs::write(&dest, plist) {
        eprintln!("Error writing plist: {}", e);
        std::process::exit(1);
    }

    let status = std::process::Command::new("launchctl")
        .args(["load", &dest.display().to_string()])
        .status();

    match status {
        Ok(s) if s.success() => println!("Daemon installed and started"),
        Ok(s) => {
            eprintln!("launchctl load exited with {}", s);
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("Failed to run launchctl: {}", e);
            std::process::exit(1);
        }
    }
}

fn daemon_uninstall() {
    let dest = plist_dest();
    if !dest.exists() {
        eprintln!("Daemon is not installed");
        std::process::exit(1);
    }

    let _ = std::process::Command::new("launchctl")
        .args(["unload", &dest.display().to_string()])
        .status();

    if let Err(e) = std::fs::remove_file(&dest) {
        eprintln!("Error removing plist: {}", e);
        std::process::exit(1);
    }
    println!("Daemon uninstalled");
}

fn daemon_status() {
    let output = std::process::Command::new("launchctl")
        .args(["list"])
        .output();

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let found = stdout
                .lines()
                .find(|l| l.contains(PLIST_LABEL));
            match found {
                Some(line) => {
                    // launchctl list format: PID Status Label
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    let pid = parts.first().unwrap_or(&"-");
                    if *pid == "-" {
                        println!("Daemon: installed but not running");
                    } else {
                        println!("Daemon: running (pid {})", pid);
                    }
                }
                None => {
                    if plist_dest().exists() {
                        println!("Daemon: installed but not loaded");
                    } else {
                        println!("Daemon: not installed");
                    }
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to run launchctl: {}", e);
            std::process::exit(1);
        }
    }
}

fn daemon_restart() {
    let uid = std::process::Command::new("id")
        .args(["-u"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8_lossy(&o.stdout).trim().parse::<u32>().ok()
            } else {
                None
            }
        })
        .unwrap_or(501);

    let service = format!("gui/{}/{}", uid, PLIST_LABEL);
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
