use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use clawtab_lib::config::settings::{AppSettings, RelaySettings};
use clawtab_lib::ipc::{self, IpcCommand, IpcResponse};
use clawtab_lib::secrets::SecretsManager;
use reqwest::{Client, Response, Url};
use serde::Deserialize;
use serde_json::json;
use std::process::Command;
use std::time::Duration;

const GOOGLE_CLIENT_ID: &str =
    "186596496380-dp282va1mvdhrr2q7qrlbgmn3ak2mq07.apps.googleusercontent.com";

struct Options {
    server: String,
    name: String,
    provider: String,
    email: Option<String>,
    no_browser: bool,
}

impl Options {
    fn parse(args: &[String], relay: Option<&RelaySettings>) -> Result<Self, String> {
        let mut options = Self {
            server: relay
                .map(|r| r.server_url.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https://relay.clawtab.cc".into()),
            name: relay
                .map(|r| r.device_name.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| gethostname::gethostname().to_string_lossy().into_owned()),
            provider: "google".into(),
            email: None,
            no_browser: false,
        };
        let mut provider_set = false;
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--no-browser" => options.no_browser = true,
                "--relay" | "--name" | "--provider" | "--email" => {
                    let value = args
                        .next()
                        .filter(|s| !s.trim().is_empty() && !s.starts_with("--"))
                        .ok_or_else(|| format!("{arg} requires a value"))?
                        .trim()
                        .to_string();
                    match arg.as_str() {
                        "--relay" => options.server = value,
                        "--name" => options.name = value,
                        "--email" => options.email = Some(value),
                        _ => {
                            options.provider = value;
                            provider_set = true;
                        }
                    }
                }
                _ => return Err(format!("Unknown login option: {arg}")),
            }
        }
        if !matches!(options.provider.as_str(), "google" | "apple") {
            return Err("--provider must be google or apple".into());
        }
        if options.email.is_some() && (provider_set || options.no_browser) {
            return Err("--email cannot be combined with --provider or --no-browser".into());
        }
        let url = Url::parse(&options.server).map_err(|_| "Invalid relay URL")?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if (url.scheme() != "https" && !(url.scheme() == "http" && local))
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Use an HTTPS relay URL, or HTTP on localhost".into());
        }
        options.server = options.server.trim_end_matches('/').into();
        Ok(options)
    }
}

#[derive(Deserialize)]
struct Account {
    user_id: String,
    access_token: String,
    refresh_token: String,
}

impl Account {
    fn validate(self) -> Result<Self, String> {
        if uuid::Uuid::parse_str(&self.user_id).is_err()
            || self.access_token.is_empty()
            || self.refresh_token.is_empty()
        {
            return Err("The relay returned an incomplete login".into());
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
struct Pairing {
    device_id: String,
    device_token: String,
}

async fn response_json<T: serde::de::DeserializeOwned>(
    response: Response,
    operation: &str,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(format!("{operation} failed (HTTP {})", response.status()));
    }
    response
        .json()
        .await
        .map_err(|_| format!("Invalid {operation} response"))
}

async fn password_login(
    client: &Client,
    server: &str,
    email: &str,
    password: &str,
) -> Result<Account, String> {
    let response = client
        .post(format!("{server}/auth/login"))
        .json(&json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|_| "Could not reach relay")?;
    response_json::<Account>(response, "Login")
        .await?
        .validate()
}

fn browser_url(options: &Options, session: &str) -> Url {
    let google = options.provider == "google";
    let mut url = Url::parse(if google {
        "https://accounts.google.com/o/oauth2/v2/auth"
    } else {
        "https://appleid.apple.com/auth/authorize"
    })
    .expect("OAuth URL");
    let state = URL_SAFE_NO_PAD.encode(format!("clawtab-cli:{session}"));
    let callback = format!("{}/auth/{}/callback", options.server, options.provider);
    let mut query = url.query_pairs_mut();
    query
        .append_pair(
            "client_id",
            if google {
                GOOGLE_CLIENT_ID
            } else {
                "cc.clawtab.web"
            },
        )
        .append_pair("redirect_uri", &callback)
        .append_pair("state", &state);
    if google {
        query
            .append_pair("response_type", "code")
            .append_pair("scope", "openid email profile")
            .append_pair("prompt", "select_account");
    } else {
        query
            .append_pair("response_type", "code id_token")
            .append_pair("response_mode", "form_post")
            .append_pair("scope", "name email");
    }
    drop(query);
    url
}

fn open_browser(url: &Url) -> bool {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    command
        .arg(url.as_str())
        .output()
        .is_ok_and(|r| r.status.success())
}

async fn poll_login(
    client: &Client,
    server: &str,
    session: &str,
) -> Result<Option<Account>, String> {
    let response = client
        .get(format!("{server}/auth/session/{session}"))
        .send()
        .await
        .map_err(|_| "Could not check login")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("Login expired; run cwt login again".into());
    }
    let value: serde_json::Value = response_json(response, "Login check").await?;
    match value["status"].as_str() {
        Some("pending") => Ok(None),
        Some("complete") => serde_json::from_value::<Account>(value)
            .map_err(|_| "The relay returned an incomplete login".into())
            .and_then(Account::validate)
            .map(Some),
        _ => Err("Unexpected login status".into()),
    }
}

async fn browser_login(client: &Client, options: &Options) -> Result<Account, String> {
    let session = uuid::Uuid::new_v4().to_string();
    let response = client
        .post(format!("{}/auth/session", options.server))
        .json(&json!({ "session_id": session }))
        .send()
        .await
        .map_err(|_| "Could not start login")?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not start login (HTTP {})",
            response.status()
        ));
    }
    let url = browser_url(options, &session);
    if options.no_browser || !open_browser(&url) {
        println!("Open this URL to sign in:\n{url}");
    } else {
        println!("Choose your account in the browser. Waiting for login...");
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    loop {
        tokio::select! {
            result = poll_login(client, &options.server, &session) => {
                if let Some(account) = result? { return Ok(account); }
            }
            _ = tokio::signal::ctrl_c() => return Err("Login canceled".into()),
            _ = tokio::time::sleep_until(deadline) => return Err("Login timed out; run cwt login again".into()),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            _ = tokio::signal::ctrl_c() => return Err("Login canceled".into()),
        }
    }
}

async fn resolve_pairing(
    client: &Client,
    options: &Options,
    account: &Account,
    existing: Option<&RelaySettings>,
    device_token: Option<String>,
) -> Result<Pairing, String> {
    if let Some(existing) =
        existing.filter(|r| r.server_url.trim_end_matches('/') == options.server)
    {
        if let Some(token) = device_token.filter(|t| !t.is_empty()) {
            let response = client
                .get(format!("{}/devices", options.server))
                .bearer_auth(&account.access_token)
                .send()
                .await
                .map_err(|_| "Could not check machine pairing")?;
            let devices: Vec<serde_json::Value> = response_json(response, "Machine lookup").await?;
            if devices
                .iter()
                .any(|d| d["id"].as_str() == Some(existing.device_id.as_str()))
            {
                return Ok(Pairing {
                    device_id: existing.device_id.clone(),
                    device_token: token,
                });
            }
        }
    }
    let response = client
        .post(format!("{}/devices/pair", options.server))
        .bearer_auth(&account.access_token)
        .json(&json!({ "device_name": options.name }))
        .send()
        .await
        .map_err(|_| "Could not pair machine")?;
    let pairing: Pairing = response_json(response, "Machine pairing").await?;
    if uuid::Uuid::parse_str(&pairing.device_id).is_err() || pairing.device_token.is_empty() {
        return Err("The relay returned an incomplete machine pairing".into());
    }
    Ok(pairing)
}

async fn daemon_command(command: IpcCommand) -> Result<(), String> {
    match ipc::send_command(command).await? {
        IpcResponse::Ok => Ok(()),
        IpcResponse::Error(error) => Err(error),
        _ => Err("Unexpected daemon response".into()),
    }
}

fn save_login(
    secrets: &mut SecretsManager,
    account: &Account,
    pairing: &Pairing,
    options: &Options,
) -> Result<(), String> {
    let values = [
        ("relay_access_token", &account.access_token),
        ("relay_refresh_token", &account.refresh_token),
        ("relay_device_token", &pairing.device_token),
    ];
    let previous: Vec<_> = values
        .iter()
        .map(|(key, _)| (*key, secrets.get(key).cloned()))
        .collect();
    let result = (|| {
        for (key, value) in values {
            secrets.set(key, value)?;
        }
        let mut settings = AppSettings::load();
        settings.relay = Some(RelaySettings {
            enabled: true,
            server_url: options.server.clone(),
            device_token: String::new(),
            device_id: pairing.device_id.clone(),
            device_name: options.name.clone(),
        });
        settings.save()
    })();
    if result.is_err() {
        for (key, value) in previous {
            let restored = match value {
                Some(value) => secrets.set(key, &value),
                None => secrets.delete(key),
            };
            if restored.is_err() {
                return Err(
                    "Could not save or restore login credentials; run cwt login again".into(),
                );
            }
        }
    }
    result
}

pub async fn login(args: &[String]) -> Result<(), String> {
    if args
        .iter()
        .any(|a| matches!(a.as_str(), "help" | "-h" | "--help"))
    {
        println!("Usage: cwt login [--provider google|apple | --email EMAIL] [--relay URL] [--name NAME] [--no-browser]");
        println!(
            "Defaults to Google sign-in in your browser. --email prompts for a hidden password."
        );
        println!("A successful login replaces the saved account and connects this machine to it.");
        return Ok(());
    }
    let settings = AppSettings::load();
    let options = Options::parse(args, settings.relay.as_ref())?;
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "Could not create login client")?;
    let account = if let Some(email) = &options.email {
        let password =
            rpassword::prompt_password("Password: ").map_err(|_| "Could not read password")?;
        password_login(&client, &options.server, email, &password).await?
    } else {
        browser_login(&client, &options).await?
    };
    let mut secrets = SecretsManager::new();
    let device_token = settings.relay.as_ref().and_then(|r| {
        if r.device_token.is_empty() {
            secrets.get("relay_device_token").cloned()
        } else {
            Some(r.device_token.clone())
        }
    });
    let pairing = resolve_pairing(
        &client,
        &options,
        &account,
        settings.relay.as_ref(),
        device_token,
    )
    .await?;
    let running = matches!(
        ipc::send_command(IpcCommand::Ping).await,
        Ok(IpcResponse::Pong)
    );
    if running {
        daemon_command(IpcCommand::RelayDisconnect).await?;
    }
    if let Err(error) = save_login(&mut secrets, &account, &pairing, &options) {
        if running {
            let _ = daemon_command(IpcCommand::RelayConnect).await;
        }
        return Err(error);
    }
    println!(
        "Signed in as account {}. Previous login replaced.",
        account.user_id
    );
    if running {
        for command in [
            IpcCommand::ReloadSecrets,
            IpcCommand::ReloadSettings,
            IpcCommand::RelayConnect,
        ] {
            daemon_command(command)
                .await
                .map_err(|error| format!("Login saved, but daemon reconnect failed: {error}"))?;
        }
        println!("Daemon is connecting with the new login.");
    } else {
        println!("Login saved. Start the daemon with cwt daemon install to connect.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    // Exercise the HTTP flow without touching the OS credential store or real accounts.
    fn server(
        responses: Vec<(&'static str, u16, serde_json::Value)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (path, status, body) in responses {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(std::time::Instant::now() < deadline, "Missing HTTP request");
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line.to_lowercase().starts_with("content-length:") {
                        length = line
                            .split(':')
                            .nth(1)
                            .unwrap()
                            .trim()
                            .parse::<usize>()
                            .unwrap();
                    }
                    request.push_str(&line);
                    if line == "\r\n" {
                        break;
                    }
                }
                let mut payload = vec![0; length];
                reader.read_exact(&mut payload).unwrap();
                request.push_str(&String::from_utf8(payload).unwrap());
                assert!(request.lines().next().unwrap().contains(path));
                requests.push(request);
                let body = body.to_string();
                write!(stream, "HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (url, thread)
    }

    fn options(server: String) -> Options {
        Options {
            server,
            name: "host".into(),
            provider: "google".into(),
            email: None,
            no_browser: true,
        }
    }

    fn account() -> Account {
        Account {
            user_id: "00000000-0000-4000-8000-000000000001".into(),
            access_token: "test-access".into(),
            refresh_token: "test-refresh".into(),
        }
    }

    #[tokio::test]
    async fn password_login_succeeds_and_rejections_do_not_echo_response_bodies() {
        let (url, thread) = server(vec![
            (
                "POST /auth/login ",
                200,
                json!({"user_id":account().user_id,"access_token":"test-access","refresh_token":"test-refresh"}),
            ),
            (
                "POST /auth/login ",
                401,
                json!({"error":"private server detail"}),
            ),
        ]);
        let client = Client::builder().no_proxy().build().unwrap();
        let result = password_login(&client, &url, "person@example.com", "test-password")
            .await
            .unwrap();
        assert_eq!(result.user_id, account().user_id);
        let error = password_login(&client, &url, "person@example.com", "incorrect")
            .await
            .err()
            .unwrap();
        assert!(error.contains("401"));
        assert!(!error.contains("private server detail"));
        let requests = thread.join().unwrap();
        assert!(requests[0].contains("person@example.com"));
        assert!(requests[0].contains("test-password"));
    }

    #[tokio::test]
    async fn browser_poll_handles_pending_complete_expired_and_incomplete() {
        let (url, thread) = server(vec![
            ("GET /auth/session/test ", 200, json!({"status":"pending"})),
            (
                "GET /auth/session/test ",
                200,
                json!({"status":"complete","user_id":account().user_id,"access_token":"test-access","refresh_token":"test-refresh"}),
            ),
            (
                "GET /auth/session/test ",
                404,
                json!({"status":"not_found"}),
            ),
            (
                "GET /auth/session/test ",
                200,
                json!({"status":"complete","user_id":account().user_id,"access_token":"test-access","refresh_token":""}),
            ),
        ]);
        let client = Client::builder().no_proxy().build().unwrap();
        assert!(poll_login(&client, &url, "test").await.unwrap().is_none());
        assert_eq!(
            poll_login(&client, &url, "test")
                .await
                .unwrap()
                .unwrap()
                .user_id,
            account().user_id
        );
        assert!(poll_login(&client, &url, "test")
            .await
            .err()
            .unwrap()
            .contains("expired"));
        assert!(poll_login(&client, &url, "test").await.is_err());
        thread.join().unwrap();
    }

    #[tokio::test]
    async fn existing_owned_machine_keeps_its_identity() {
        let id = "00000000-0000-4000-8000-000000000002";
        let (url, thread) = server(vec![("GET /devices ", 200, json!([{"id":id}]))]);
        let existing = RelaySettings {
            server_url: url.clone(),
            device_id: id.into(),
            ..RelaySettings::default()
        };
        let result = resolve_pairing(
            &Client::builder().no_proxy().build().unwrap(),
            &options(url),
            &account(),
            Some(&existing),
            Some("test-device".into()),
        )
        .await
        .unwrap();
        assert_eq!(result.device_id, id);
        assert_eq!(result.device_token, "test-device");
        assert_eq!(thread.join().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn different_account_gets_a_new_pairing() {
        let id = "00000000-0000-4000-8000-000000000003";
        let (url, thread) = server(vec![
            ("GET /devices ", 200, json!([])),
            (
                "POST /devices/pair ",
                200,
                json!({"device_id":id,"device_token":"new-test-device"}),
            ),
        ]);
        let existing = RelaySettings {
            server_url: url.clone(),
            device_id: "old-device".into(),
            ..RelaySettings::default()
        };
        let result = resolve_pairing(
            &Client::builder().no_proxy().build().unwrap(),
            &options(url),
            &account(),
            Some(&existing),
            Some("old-test-device".into()),
        )
        .await
        .unwrap();
        assert_eq!(result.device_id, id);
        let requests = thread.join().unwrap();
        assert!(requests[1].contains("Bearer test-access"));
        assert!(requests[1].contains("\"device_name\":\"host\""));
    }

    #[test]
    fn login_options_validate_before_authentication() {
        for args in [
            vec!["--password", "secret"],
            vec!["--relay"],
            vec!["--relay", "http://example.com"],
            vec!["--provider", "other"],
            vec!["--email", "a@b.cc", "--provider", "google"],
        ] {
            let args = args.into_iter().map(String::from).collect::<Vec<_>>();
            assert!(Options::parse(&args, None).is_err());
        }
        let existing = RelaySettings {
            server_url: "https://relay.example.com/".into(),
            device_name: "my-host".into(),
            ..RelaySettings::default()
        };
        let parsed = Options::parse(&[], Some(&existing)).unwrap();
        assert_eq!(parsed.server, "https://relay.example.com");
        assert_eq!(parsed.name, "my-host");
        let url = browser_url(&parsed, "test-session");
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(query["prompt"], "select_account");
        assert_eq!(
            URL_SAFE_NO_PAD.decode(query["state"].as_bytes()).unwrap(),
            b"clawtab-cli:test-session"
        );
    }
}
