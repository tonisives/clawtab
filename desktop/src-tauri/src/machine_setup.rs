use crate::config::settings::{AppSettings, RelaySettings};
use serde_json::{json, Value};
use std::time::Duration;

pub async fn setup(args: &[String]) -> Result<(), String> {
    if let Some(path) = args
        .windows(2)
        .find(|w| w[0] == "--enrollment-file")
        .map(|w| &w[1])
    {
        return enroll_rental(path, args).await;
    }
    pair_machine(args).await
}

async fn pair_machine(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a == "--no-service") && args.iter().any(|a| a == "--linger") {
        return Err("--no-service cannot be combined with --linger".into());
    }
    let flag = |key: &str| args.windows(2).find(|w| w[0] == key).map(|w| w[1].clone());
    let server = flag("--relay")
        .unwrap_or_else(|| "https://relay.clawtab.cc".into())
        .trim_end_matches('/')
        .to_owned();
    let url = reqwest::Url::parse(&server).map_err(|_| "invalid relay URL")?;
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        return Err("use HTTPS for remote relays".into());
    }
    if AppSettings::load()
        .relay
        .as_ref()
        .is_some_and(|r| !r.device_id.is_empty())
        && !args.iter().any(|a| a == "--replace")
    {
        return Err("machine is already paired; use --replace to deliberately pair again".into());
    }
    for tool in ["tmux", "git", "python3"] {
        if !std::process::Command::new(tool)
            .arg(if tool != "tmux" { "--version" } else { "-V" })
            .output()
            .is_ok_and(|o| o.status.success())
        {
            return Err(format!("install {tool} before running setup"));
        }
    }
    let name =
        flag("--name").unwrap_or_else(|| gethostname::gethostname().to_string_lossy().into_owned());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let response=client.post(format!("{server}/machines/pairing")).json(&json!({"name":name,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH})).send().await.map_err(|_|"could not reach relay")?.error_for_status().map_err(|_|"relay rejected setup")?;
    let pairing: Value = response
        .json()
        .await
        .map_err(|_| "invalid pairing response")?;
    let code = pairing["code"].as_str().ok_or("missing pairing code")?;
    println!(
        "Open ClawTab > Machines > Add machine, and approve code {code}. It expires in 10 minutes."
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(10)).await;
        let response = match client
            .post(format!("{server}/machines/pairing/poll"))
            .json(&json!({"pairing_id":pairing["pairing_id"],"poll_token":pairing["poll_token"]}))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => continue,
        };
        if response.status().as_u16() == 429 {
            continue;
        }
        let value: Value = response
            .error_for_status()
            .map_err(|_| "pairing expired or rejected")?
            .json()
            .await
            .map_err(|_| "invalid relay response")?;
        if value["status"] != "paired" {
            continue;
        }
        return save_pairing(value, server, name, args).await;
    }
    Err("pairing timed out; run setup again".into())
}

async fn enroll_rental(path: &str, args: &[String]) -> Result<(), String> {
    let contents = std::fs::read(path).map_err(|_| "could not read enrollment file")?;
    let config: Value = serde_json::from_slice(&contents).map_err(|_| "invalid enrollment file")?;
    let field = |key: &str| {
        config[key]
            .as_str()
            .ok_or_else(|| format!("missing enrollment {key}"))
    };
    let backend = field("backend")?;
    let relay = field("relay")?;
    for endpoint in [backend, relay] {
        let url = reqwest::Url::parse(endpoint).map_err(|_| "invalid enrollment endpoint")?;
        if url.scheme() != "https" {
            return Err("enrollment requires HTTPS".into());
        }
    }
    let rental = field("rental_id")?;
    let token = field("token")?;
    let name = field("name")?;
    let mut settings = AppSettings::load();
    settings.default_work_dir = dirs::home_dir()
        .ok_or("home directory unavailable")?
        .join("workspace")
        .to_string_lossy()
        .into_owned();
    settings.default_provider = crate::agent_session::ProcessProvider::Codex;
    settings.save()?;
    // Persist the host-generated credential before exchange. A lost response can
    // retry the same enrollment without issuing another credential or machine.
    let credential_key = format!("rental_enrollment_{rental}");
    let mut secrets = crate::secrets::SecretsManager::new();
    let credential = match secrets.get(&credential_key).cloned() {
        Some(value) => value,
        None => {
            let value = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            secrets.set(&credential_key, &value)?;
            value
        }
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "could not create enrollment client")?;
    for _ in 0..30 {
        let response = client
            .post(format!("{backend}/rentals/enroll"))
            .json(&json!({"rental_id":rental,"token":token,"device_token":credential}))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                let mut value: Value = response
                    .json()
                    .await
                    .map_err(|_| "invalid enrollment response")?;
                value["device_token"] = json!(credential);
                save_pairing(value, relay.into(), name.into(), args).await?;
                secrets.delete(&credential_key)?;
                return Ok(());
            }
            Ok(response) if response.status().is_client_error() => {
                return Err("enrollment was rejected or expired".into())
            }
            _ => tokio::time::sleep(Duration::from_secs(10)).await,
        }
    }
    Err("enrollment timed out".into())
}

async fn save_pairing(
    value: Value,
    server: String,
    name: String,
    _args: &[String],
) -> Result<(), String> {
    let token = value["device_token"]
        .as_str()
        .ok_or("missing device credential")?;
    let id = value["device_id"].as_str().ok_or("missing machine ID")?;
    crate::secrets::SecretsManager::new().set("relay_device_token", token)?;
    let mut settings = AppSettings::load();
    settings.relay = Some(RelaySettings {
        enabled: true,
        server_url: server,
        device_token: String::new(),
        device_id: id.into(),
        device_name: name,
    });
    settings.save()?;
    println!("Machine paired. Provider credentials stay on this machine.");
    #[cfg(target_os = "linux")]
    {
        if _args.iter().any(|arg| arg == "--no-service") {
            connect_running_daemon(_args).await?;
            return Ok(());
        }
        if _args.iter().any(|arg| arg == "--linger") {
            let status = std::process::Command::new("loginctl")
                .arg("enable-linger")
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("paired, but enabling lingering failed; run cwtctl daemon install after configuring the user systemd manager".into());
            }
        }
        println!("{}", crate::daemon::install()?);
        println!("To keep the user service running after logout and start it at boot, enable lingering: loginctl enable-linger <your-user>. Your host may require administrator approval.");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
async fn connect_running_daemon(args: &[String]) -> Result<(), String> {
    use crate::ipc::{self, IpcCommand, IpcResponse};

    if !ipc::daemon_socket_path().exists() {
        println!(
            "Service installation skipped. Start clawtab-daemon with your container supervisor."
        );
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--replace") {
        println!("Replacement pairing saved. Restart your container when ready to load the new credentials.");
        return Ok(());
    }
    for command in [
        IpcCommand::ReloadSecrets,
        IpcCommand::ReloadSettings,
        IpcCommand::RelayConnect,
    ] {
        match ipc::send_command(command).await {
            Ok(IpcResponse::Ok) => {}
            _ => return Err("paired, but the running daemon could not load the connection; restart it when ready".into()),
        }
    }
    println!("The running daemon is connecting to the relay. No service restart is needed.");
    Ok(())
}
