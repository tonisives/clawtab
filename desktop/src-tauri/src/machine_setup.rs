use crate::config::settings::{AppSettings, RelaySettings};
use serde_json::{json, Value};
use std::time::Duration;

pub async fn setup(args: &[String]) -> Result<(), String> {
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
        return save_pairing(value, server, name, args);
    }
    Err("pairing timed out; run setup again".into())
}

fn save_pairing(
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
            let ready = crate::config::config_dir()
                .ok_or("home directory unavailable")?
                .join("machine-paired");
            std::fs::write(ready, id).map_err(|e| format!("could not mark pairing ready: {e}"))?;
            println!("Service installation skipped. Start clawtab-daemon with your container supervisor.");
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
