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
                    eprintln!("Error: not in a tmux pane (no $TMUX_PANE). Pass pane_id explicitly.");
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
        "auto-yes" => {
            if args.len() >= 3 && args[2] == "toggle" {
                let pane_id = if args.len() >= 4 {
                    args[3].clone()
                } else {
                    env::var("TMUX_PANE").unwrap_or_else(|_| {
                        eprintln!("Error: not in a tmux pane (no $TMUX_PANE). Pass pane_id explicitly.");
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
