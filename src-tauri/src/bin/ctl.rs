use std::env;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
enum IpcCommand {
    Ping,
    ListJobs,
    RunJob { name: String },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
enum IpcResponse {
    Pong,
    Ok,
    Jobs(Vec<String>),
    Error(String),
}

fn socket_path() -> PathBuf {
    PathBuf::from("/tmp/clawdtab.sock")
}

async fn send_command(cmd: IpcCommand) -> Result<IpcResponse, String> {
    let path = socket_path();

    let stream = UnixStream::connect(&path)
        .await
        .map_err(|e| format!("Failed to connect (is clawdtab running?): {}", e))?;

    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);

    let cmd_str = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    writer
        .write_all(cmd_str.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    writer.write_all(b"\n").await.map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())?;

    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;

    let response: IpcResponse =
        serde_json::from_str(line.trim()).map_err(|e| format!("Invalid response: {}", e))?;

    Ok(response)
}

fn print_usage() {
    eprintln!("cwdtctl -- CLI for ClawdTab");
    eprintln!();
    eprintln!("Usage: cwdtctl <command>");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  ping              Check if ClawdTab is running");
    eprintln!("  list              List all jobs");
    eprintln!("  run <name>        Run a job by name");
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
        "run" => {
            if args.len() < 3 {
                eprintln!("Error: 'run' requires a job name");
                std::process::exit(1);
            }
            IpcCommand::RunJob {
                name: args[2].clone(),
            }
        }
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

    match send_command(ipc_cmd).await {
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
