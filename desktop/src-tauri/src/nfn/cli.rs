use super::{templates, NfnCommand, NfnRequest};
use crate::ipc::{self, IpcCommand, IpcResponse};
use serde_json::{json, Value};
use std::io::Read;

pub async fn call(command: NfnCommand) -> Result<Value, String> {
    match ipc::send_command(IpcCommand::Nfn { command }).await? {
        IpcResponse::Nfn(value) => Ok(value),
        IpcResponse::Error(error) => Err(error),
        _ => Err("Unexpected notification response".into()),
    }
}

fn stdin() -> Result<String, String> {
    let mut value = String::new();
    std::io::stdin()
        .take(512 * 1024 + 1)
        .read_to_string(&mut value)
        .map_err(|e| e.to_string())?;
    if value.len() > 512 * 1024 {
        return Err("Notification input exceeds 512 KiB".into());
    }
    Ok(value)
}

pub async fn run(args: &[String]) -> Result<Value, String> {
    if args.is_empty() || matches!(args[0].as_str(), "help" | "--help" | "-h") {
        return Ok(json!({"usage":[
            "cwtctl nfn send --stdin [--template ID] [--wait] [--timeout SECONDS]",
            "cwtctl nfn get|wait|cancel ID [--timeout SECONDS]",
            "cwtctl nfn templates list",
            "cwtctl nfn templates validate [FILE | --stdin]",
            "cwtctl nfn show"
        ],"response_destination":["result","agent_message"],"template_directory":templates::directory()}));
    }
    let timeout = flag_value(args, "--timeout")?
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| "timeout must be seconds".to_string())
        })
        .transpose()?;
    match args[0].as_str() {
        "send" => {
            if !args.iter().any(|a| a == "--stdin") {
                return Err("Use nfn send --stdin with a JSON request".into());
            }
            validate_flags(
                &args[1..],
                &["--stdin", "--wait"],
                &["--template", "--timeout"],
            )?;
            let mut request: NfnRequest =
                serde_json::from_str(&stdin()?).map_err(|e| e.to_string())?;
            if let Some(template) = flag_value(args, "--template")? {
                request.template = template.into();
            }
            if request.source.pane_id.is_none() && request.source.job_id.is_none() {
                request.source.pane_id = std::env::var("CLAWTAB_SESSION_ID")
                    .or_else(|_| std::env::var("TMUX_PANE"))
                    .ok();
            }
            let waits = args.iter().any(|a| a == "--wait");
            if waits && request.response_destination != "result" {
                return Err("--wait requires response_destination: result".into());
            }
            request.validate()?;
            let record = call(NfnCommand::Send { request }).await?;
            if waits {
                wait(record["id"].as_str().ok_or("Missing request ID")?, timeout).await
            } else {
                Ok(record)
            }
        }
        "get" | "wait" | "cancel" => {
            let id = args
                .get(1)
                .filter(|a| !a.starts_with('-'))
                .ok_or("Pass a notification ID")?
                .clone();
            validate_flags(
                &args[2..],
                &[],
                if args[0] == "wait" {
                    &["--timeout"]
                } else {
                    &[]
                },
            )?;
            if args[0] == "wait" {
                wait(&id, timeout).await
            } else if args[0] == "cancel" {
                call(NfnCommand::Cancel { id }).await
            } else {
                call(NfnCommand::Get { id }).await
            }
        }
        "show" => {
            validate_flags(&args[1..], &[], &[])?;
            call(NfnCommand::Show).await
        }
        "templates" => match args.get(1).map(String::as_str) {
            Some("list") => Ok(templates::list()),
            Some("validate") => {
                let yaml = match args.get(2).map(String::as_str) {
                    Some(path) if path != "--stdin" => {
                        std::fs::read_to_string(path).map_err(|e| e.to_string())?
                    }
                    _ => stdin()?,
                };
                Ok(json!({"template":templates::parse(&yaml)?}))
            }
            _ => Err("Use nfn templates list or nfn templates validate [FILE | --stdin]".into()),
        },
        _ => Err("Unknown nfn command; use cwtctl nfn help".into()),
    }
}

fn flag_value<'a>(args: &'a [String], flag: &str) -> Result<Option<&'a str>, String> {
    let Some(i) = args.iter().position(|a| a == flag) else {
        return Ok(None);
    };
    args.get(i + 1)
        .filter(|value| !value.starts_with("--"))
        .map(|value| Some(value.as_str()))
        .ok_or_else(|| format!("Pass a value after {flag}"))
}

fn validate_flags(args: &[String], switches: &[&str], values: &[&str]) -> Result<(), String> {
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if switches.contains(&arg.as_str()) {
            continue;
        }
        if values.contains(&arg.as_str()) {
            if args.next().is_none_or(|value| value.starts_with("--")) {
                return Err(format!("Pass a value after {arg}"));
            }
        } else {
            return Err(format!("Unknown argument: {arg}"));
        }
    }
    Ok(())
}

async fn wait(id: &str, timeout: Option<u64>) -> Result<Value, String> {
    let started = std::time::Instant::now();
    loop {
        let record = call(NfnCommand::Get { id: id.into() }).await?;
        if !matches!(record["status"].as_str(), Some("pending" | "delivering")) {
            return Ok(record);
        }
        if timeout.is_some_and(|seconds| started.elapsed().as_secs() >= seconds) {
            return Ok(json!({"id":id,"status":record["status"],"wait_timed_out":true}));
        }
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_and_unknown_options_are_errors() {
        assert!(flag_value(&["--timeout".into()], "--timeout").is_err());
        assert!(validate_flags(&["--wai".into()], &["--wait"], &[]).is_err());
        assert!(validate_flags(
            &["--template".into(), "--wait".into()],
            &["--wait"],
            &["--template"]
        )
        .is_err());
    }
}
