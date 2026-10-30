use super::{settings, templates, NfnAction, NfnCommand, NfnRequest, NfnSource};
use crate::agent_session::{self, AgentIdentity, ProcessProvider};
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

pub async fn message(args: &[String]) -> Result<Value, String> {
    if args.is_empty() || matches!(args[0].as_str(), "help" | "--help" | "-h") {
        return Ok(json!({"usage":[
            "cwtctl message send TEXT [--kind update|question|approval|completed|failed]",
            "  [--channel desktop|mobile|telegram] [--choice [ID=]LABEL] [--wait] [--timeout SECONDS]",
            "  [--title TITLE] [--template ID] [--chat ID] [--response-destination result|agent_message]",
            "  [--image PATH_OR_URL] [--video PATH_OR_URL] (repeat for multiple attachments)",
            "cwtctl message send --stdin [--wait] [--timeout SECONDS]",
            "cwtctl message list [--pending] [--offset N] [--query TEXT]",
            "cwtctl message get|wait|cancel|read|dismiss ID [--timeout SECONDS]",
            "cwtctl message ignore|unignore ID",
            "cwtctl message ignored-agents",
            "cwtctl message reply ID [TEXT] [--action ID]",
            "cwtctl message show|settings|templates [args]"
        ]}));
    }
    match args[0].as_str() {
        "send" => {
            let (request, waits, timeout) = parse_message(&args[1..])?;
            submit(request, waits, timeout).await
        }
        "list" => {
            validate_flags(&args[1..], &["--pending"], &["--offset", "--query"])?;
            let offset = flag_value(args, "--offset")?
                .unwrap_or("0")
                .parse()
                .map_err(|_| "offset must be a number")?;
            call(NfnCommand::List {
                offset,
                pending_only: args.iter().any(|a| a == "--pending"),
                query: flag_value(args, "--query")?.unwrap_or("").to_owned(),
            })
            .await
        }
        "ignored-agents" => call(NfnCommand::IgnoredAgents).await,
        "read" | "dismiss" | "ignore" | "unignore" => {
            if args.len() != 2 {
                return Err("Pass a message ID".into());
            }
            let id = args[1].clone();
            call(match args[0].as_str() {
                "read" => NfnCommand::Read { id },
                "ignore" => NfnCommand::Ignore { id },
                "unignore" => NfnCommand::Unignore { id },
                _ => NfnCommand::Dismiss { id },
            })
            .await
        }
        "reply" => {
            let id = args
                .get(1)
                .filter(|v| !v.starts_with('-'))
                .ok_or("Pass a message ID")?
                .clone();
            let mut text = Vec::new();
            let mut action_id = "reply".to_string();
            let mut values = args[2..].iter();
            while let Some(value) = values.next() {
                if value == "--action" {
                    action_id = values.next().ok_or("Pass an action ID")?.clone();
                } else if value.starts_with('-') {
                    return Err(format!("Unknown argument: {value}"));
                } else {
                    text.push(value.as_str());
                }
            }
            call(NfnCommand::Respond {
                id,
                action_id,
                text: (!text.is_empty()).then(|| text.join(" ")),
                decisions: None,
            })
            .await
        }
        _ => run(args).await,
    }
}

fn parse_message(args: &[String]) -> Result<(NfnRequest, bool, Option<u64>), String> {
    let mut text = Vec::new();
    let mut flags: std::collections::HashMap<&str, Vec<&str>> = Default::default();
    let mut input = false;
    let mut waits = false;
    let mut values = args.iter();
    while let Some(value) = values.next() {
        match value.as_str() {
            "--stdin" => input = true,
            "--wait" => waits = true,
            "--kind"
            | "--channel"
            | "--choice"
            | "--title"
            | "--template"
            | "--timeout"
            | "--chat"
            | "--image"
            | "--video"
            | "--response-destination" => {
                let next = values
                    .next()
                    .filter(|v| !v.starts_with("--"))
                    .ok_or_else(|| format!("Pass a value after {value}"))?;
                if !matches!(
                    value.as_str(),
                    "--choice" | "--channel" | "--image" | "--video"
                ) && flags.contains_key(value.as_str())
                {
                    return Err(format!("Duplicate argument: {value}"));
                }
                flags.entry(value).or_default().push(next);
            }
            "--" => {
                text.extend(values.map(String::as_str));
                break;
            }
            value if value.starts_with('-') => return Err(format!("Unknown argument: {value}")),
            value => text.push(value),
        }
    }
    let value = |name: &str| flags.get(name).and_then(|v| v.first()).copied();
    if input && !text.is_empty() {
        return Err("Use text or --stdin".into());
    }
    let mut request = if input {
        serde_json::from_str(&stdin()?).map_err(|e| e.to_string())?
    } else {
        let body = text.join(" ");
        if body.trim().is_empty() {
            return Err("Pass message text or --stdin".into());
        }
        NfnRequest {
            title: body
                .lines()
                .next()
                .unwrap_or("Message")
                .chars()
                .take(120)
                .collect(),
            body,
            kind: "update".into(),
            template: "update".into(),
            ..Default::default()
        }
    };
    if let Some(kind) = value("--kind") {
        request.kind = kind.into();
        if !input && value("--template").is_none() {
            request.template = match kind {
                "question" => "question",
                "approval" => "permission",
                _ => "update",
            }
            .into();
        }
    }
    if let Some(title) = value("--title") {
        request.title = title.into();
    }
    if let Some(template) = value("--template") {
        request.template = template.into();
        if value("--kind").is_none() {
            request.kind.clear();
        }
    }
    if let Some(channels) = flags.get("--channel") {
        request.channels = channels.iter().map(|v| v.to_string()).collect();
    }
    if let Some(choices) = flags.get("--choice") {
        request.actions = choices
            .iter()
            .enumerate()
            .map(|(i, value)| {
                let (id, label) = value
                    .split_once('=')
                    .map(|(id, label)| (id.to_string(), label))
                    .unwrap_or_else(|| (format!("choice-{}", i + 1), *value));
                NfnAction {
                    id,
                    label: label.into(),
                    value: label.into(),
                    ..Default::default()
                }
            })
            .collect();
        if value("--kind").is_none() {
            request.kind = "question".into();
            request.template = "question".into();
        }
    }
    if let Some(chat) = value("--chat") {
        request.telegram_chat_id =
            Some(chat.parse().map_err(|_| "chat must be a numeric chat ID")?);
        if !request.channels.iter().any(|channel| channel == "telegram") {
            request.channels.push("telegram".into());
        }
    }
    if let Some(destination) = value("--response-destination") {
        request.response_destination = destination.into();
    }
    for kind in ["image", "video"] {
        if let Some(paths) = flags.get(format!("--{kind}").as_str()) {
            for path in paths {
                request.media.push(super::NfnMedia {
                    kind: kind.into(),
                    src: (*path).into(),
                    alt: String::new(),
                });
            }
        }
    }
    if !input && request.message_kind() == "question" && request.actions.is_empty() {
        request.data["text_input"] = json!(true);
    }
    if waits && (!request.needs_response() || request.response_destination != "result") {
        return Err(
            "--wait requires a question or approval with response_destination: result".into(),
        );
    }
    let timeout = value("--timeout")
        .map(|v| v.parse().map_err(|_| "timeout must be seconds"))
        .transpose()?;
    Ok((request, waits, timeout))
}

async fn submit(
    mut request: NfnRequest,
    waits: bool,
    timeout: Option<u64>,
) -> Result<Value, String> {
    infer_source(
        &mut request.source,
        std::env::var("CODEX_THREAD_ID").ok().as_deref(),
        std::env::var("CLAWTAB_SESSION_ID").ok().as_deref(),
        std::env::var("TMUX_PANE").ok().as_deref(),
        agent_session::agent_identities,
    )?;
    request.validate()?;
    let record = call(NfnCommand::Send { request }).await?;
    if waits {
        wait(record["id"].as_str().ok_or("Missing message ID")?, timeout).await
    } else {
        Ok(record)
    }
}

pub async fn run(args: &[String]) -> Result<Value, String> {
    if args.is_empty() || matches!(args[0].as_str(), "help" | "--help" | "-h") {
        return Ok(json!({"usage":[
            "cwtctl nfn send --stdin [--template ID] [--wait] [--timeout SECONDS]",
            "cwtctl nfn get|wait|cancel ID [--timeout SECONDS]",
            "cwtctl nfn templates list",
            "cwtctl nfn templates validate [FILE | --stdin]",
            "cwtctl nfn show",
            "cwtctl nfn todos list",
            "cwtctl nfn todos link NOTE.md [agents.json]",
            "cwtctl nfn settings [FILE.yaml | --stdin | --json | --ui]"
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
        "todos" => match args.get(1).map(String::as_str) {
            None | Some("list") => call(NfnCommand::Todos).await,
            Some("link") if (3..=4).contains(&args.len()) => {
                call(NfnCommand::TodoLink {
                    note: args[2].clone(),
                    agents: args.get(3).cloned(),
                })
                .await
            }
            _ => Err("Use nfn todos list or nfn todos link NOTE.md [agents.json]".into()),
        },
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
            infer_source(
                &mut request.source,
                std::env::var("CODEX_THREAD_ID").ok().as_deref(),
                std::env::var("CLAWTAB_SESSION_ID").ok().as_deref(),
                std::env::var("TMUX_PANE").ok().as_deref(),
                agent_session::agent_identities,
            )?;
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
        "settings" => {
            if args.len() > 2 {
                return Err("Use nfn settings [FILE.yaml | --stdin | --json | --ui]".into());
            }
            if args.get(1).is_none_or(|arg| arg == "--ui") {
                return call(NfnCommand::Settings).await;
            }
            let fallback = crate::config::settings::AppSettings::load().enhanced_notifications;
            let current = settings::ensure(&fallback)?;
            let input = &args[1];
            if input == "--json" {
                return Ok(json!({"path":settings::path()?,"settings":current}));
            }
            let yaml = if input == "--stdin" {
                stdin()?
            } else if input.starts_with('-') {
                return Err(format!("Unknown argument: {input}"));
            } else {
                std::fs::read_to_string(input).map_err(|error| error.to_string())?
            };
            let next = settings::parse(&yaml, &current)?;
            settings::save(&next)?;
            let reloaded = matches!(
                ipc::send_command(IpcCommand::ReloadSettings).await,
                Ok(IpcResponse::Ok)
            );
            Ok(json!({"path":settings::path()?,"settings":next,"reloaded":reloaded}))
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

fn infer_source(
    source: &mut NfnSource,
    codex_thread: Option<&str>,
    managed_pane: Option<&str>,
    tmux_pane: Option<&str>,
    identities: impl FnOnce() -> Result<Vec<AgentIdentity>, String>,
) -> Result<(), String> {
    if source.pane_id.is_some() || source.job_id.is_some() {
        return Ok(());
    }
    let managed_pane = managed_pane.filter(|value| !value.is_empty());
    let Some(thread) = codex_thread.filter(|value| !value.is_empty()) else {
        source.pane_id = managed_pane.or(tmux_pane).map(str::to_owned);
        return Ok(());
    };
    if source.session_id.as_deref().is_some_and(|id| id != thread) {
        return Err("Pass source.pane_id to send from a different agent session".into());
    }
    let pane = if let Some(pane) = managed_pane.filter(|pane| crate::managed::is_managed(pane)) {
        pane.to_owned()
    } else {
        // Shared command runners can inherit TMUX_PANE from another conversation.
        let matches: std::collections::HashSet<_> = identities()?
            .into_iter()
            .filter(|identity| {
                identity.provider == ProcessProvider::Codex
                    && identity.session_id.as_deref() == Some(thread)
            })
            .map(|identity| identity.pane_id)
            .collect();
        if matches.len() != 1 {
            return Err(format!(
                "Could not identify one pane for Codex session {thread}; pass source.pane_id explicitly"
            ));
        }
        matches.into_iter().next().unwrap()
    };
    source.pane_id = Some(pane);
    // The daemon checks this again before binding the notification to the agent.
    source.session_id = Some(thread.to_owned());
    Ok(())
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

    fn message_args(args: &[&str]) -> Result<(NfnRequest, bool, Option<u64>), String> {
        parse_message(
            &args
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn plain_messages_are_updates_and_questions_can_wait_for_text() {
        let (update, waits, _) = message_args(&["Build finished"]).unwrap();
        assert_eq!(update.message_kind(), "update");
        assert_eq!(update.template, "update");
        assert!(!waits);
        let (question, waits, timeout) = message_args(&[
            "Which branch?",
            "--kind",
            "question",
            "--wait",
            "--timeout",
            "120",
        ])
        .unwrap();
        assert!(question.needs_response());
        assert_eq!(question.data["text_input"], true);
        assert!(question.actions.is_empty());
        assert!(waits);
        assert_eq!(timeout, Some(120));
    }

    #[test]
    fn choices_and_channels_share_one_question() {
        let (request, _, _) = message_args(&[
            "Ship?",
            "--choice",
            "yes=Ship",
            "--choice",
            "Revise",
            "--channel",
            "desktop",
            "--channel",
            "telegram",
            "--chat",
            "-123",
        ])
        .unwrap();
        request.validate().unwrap();
        assert_eq!(request.message_kind(), "question");
        assert_eq!(request.actions[0].id, "yes");
        assert_eq!(request.actions[1].id, "choice-2");
        assert_eq!(request.channels, vec!["desktop", "telegram"]);
        assert_eq!(request.telegram_chat_id, Some(-123));
        assert!(message_args(&["Done", "--wait"]).is_err());
        assert!(message_args(&[
            "Question",
            "--kind",
            "question",
            "--wait",
            "--response-destination",
            "agent_message"
        ])
        .is_err());
    }

    #[test]
    fn message_options_are_strict_and_literal_text_can_start_with_a_dash() {
        for args in [
            vec!["hi", "--kind"],
            vec!["hi", "--unknown"],
            vec!["hi", "--kind", "update", "--kind", "question"],
            vec!["hi", "--timeout", "soon"],
        ] {
            assert!(message_args(&args).is_err());
        }
        let (request, _, _) = message_args(&["--", "--literal", "text"]).unwrap();
        assert_eq!(request.body, "--literal text");
    }

    fn identity(pane: &str, session: &str) -> AgentIdentity {
        AgentIdentity {
            pane_id: pane.into(),
            window_id: "@1".into(),
            pane_pid: "123".into(),
            provider: ProcessProvider::Codex,
            session_id: Some(session.into()),
        }
    }

    #[test]
    fn caller_thread_wins_over_a_stale_shared_tmux_pane() {
        let mut source = NfnSource::default();
        infer_source(&mut source, Some("sender"), None, Some("%2"), || {
            Ok(vec![
                identity("%2", "other-agent"),
                identity("%58", "sender"),
                identity("%58", "sender"),
            ])
        })
        .unwrap();
        assert_eq!(source.pane_id.as_deref(), Some("%58"));
        assert_eq!(source.session_id.as_deref(), Some("sender"));
    }

    #[test]
    fn missing_or_ambiguous_threads_never_fall_back_to_another_pane() {
        let mut other_provider = identity("%2", "sender");
        other_provider.provider = ProcessProvider::Claude;
        for identities in [
            vec![],
            vec![identity("%2", "other-agent")],
            vec![other_provider],
            vec![identity("%1", "sender"), identity("%2", "sender")],
        ] {
            let mut source = NfnSource::default();
            assert!(
                infer_source(&mut source, Some("sender"), None, Some("%2"), || {
                    Ok(identities)
                })
                .is_err()
            );
            assert_eq!(source, NfnSource::default());
        }
    }

    #[test]
    fn explicit_panes_and_jobs_keep_their_source() {
        for mut source in [
            NfnSource {
                pane_id: Some("%9".into()),
                session_id: Some("explicit-session".into()),
                ..Default::default()
            },
            NfnSource {
                job_id: Some("binary-job".into()),
                ..Default::default()
            },
        ] {
            let expected = source.clone();
            infer_source(&mut source, Some("sender"), None, Some("%2"), || {
                panic!("Explicit sources do not need caller discovery")
            })
            .unwrap();
            assert_eq!(source, expected);
        }
    }

    #[test]
    fn managed_and_plain_terminal_senders_keep_their_pane() {
        let managed = "managed:11111111-1111-4111-8111-111111111111";
        for (thread, managed_pane, tmux_pane, expected) in [
            (Some("sender"), Some(managed), Some("%2"), Some(managed)),
            (None, Some(managed), Some("%2"), Some(managed)),
            (None, None, Some("%2"), Some("%2")),
            (Some(""), Some(""), Some("%2"), Some("%2")),
            (None, None, None, None),
        ] {
            let mut source = NfnSource::default();
            infer_source(&mut source, thread, managed_pane, tmux_pane, || {
                panic!("This sender does not need tmux identity discovery")
            })
            .unwrap();
            assert_eq!(source.pane_id.as_deref(), expected);
            assert_eq!(
                source.session_id.as_deref(),
                thread.filter(|id| !id.is_empty())
            );
        }
    }

    #[test]
    fn explicit_session_cannot_be_silently_replaced() {
        let mut source = NfnSource {
            session_id: Some("another-session".into()),
            ..Default::default()
        };
        assert!(
            infer_source(&mut source, Some("sender"), None, Some("%2"), || {
                panic!("Conflicting session should be rejected before discovery")
            })
            .is_err()
        );
        assert_eq!(source.session_id.as_deref(), Some("another-session"));
        assert!(source.pane_id.is_none());
    }

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
