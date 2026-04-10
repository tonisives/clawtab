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
