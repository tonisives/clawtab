use std::env;

use clawdtab_lib::ipc::{self, IpcCommand, IpcResponse};

fn print_usage() {
    eprintln!("cwdtctl -- CLI for ClawdTab");
    eprintln!();
    eprintln!("Usage: cwdtctl <command> [args]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  ping              Check if ClawdTab is running");
    eprintln!("  list | ls         List all jobs");
    eprintln!("  run <name>        Run a job by name");
    eprintln!("  pause <name>      Pause a running job");
    eprintln!("  resume <name>     Resume a paused job");
    eprintln!("  restart <name>    Restart a job");
    eprintln!("  status            Show job statuses");
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

    let ipc_cmd = match command {
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
        "help" | "-h" | "--help" => {
            print_usage();
            std::process::exit(0);
        }
        _ => {
            eprintln!("Unknown command: {}", command);
            print_usage();
            std::process::exit(1);
        }
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
