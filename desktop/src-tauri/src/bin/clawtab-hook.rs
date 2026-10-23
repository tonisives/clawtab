use clawtab_lib::agent_hooks::{write_event, HookEventV1};
use clawtab_lib::agent_session::ProcessProvider;
use serde_json::Value;
use std::io::{self, Read};

const MAX_INPUT_BYTES: u64 = 256 * 1024;

// Hermes includes conversation history in some hooks. Deserialize only routing
// fields so a long transcript never gets copied into ClawTab's event spool.
#[derive(serde::Deserialize, serde::Serialize)]
struct HermesPayload {
    session_id: String,
    #[serde(default)]
    extra: HermesExtra,
}

#[derive(Default, serde::Deserialize, serde::Serialize)]
struct HermesExtra {
    kind: Option<String>,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let provider = args
        .get(1)
        .and_then(|value| ProcessProvider::from_name(value));
    let event_name = args.get(2).map(String::as_str);
    let antigravity = provider == Some(ProcessProvider::Antigravity);
    if let (Some(provider), Some(event_name)) = (provider, event_name) {
        if provider == ProcessProvider::Hermes {
            if let Ok(input) = serde_json::from_reader::<_, HermesPayload>(
                io::stdin().lock().take(64 * 1024 * 1024),
            ) {
                if let Ok(mut payload) = serde_json::to_value(input) {
                    if let Ok(home) = std::env::var("HERMES_HOME") {
                        payload["clawtab_hermes_home"] = Value::String(home);
                        if let Some(event) = HookEventV1::from_provider_payload(
                            provider, event_name, &payload, None, None,
                        ) {
                            let _ = write_event(&event);
                        }
                    }
                }
            }
            print!("{{}}");
            return;
        }
        let mut input = Vec::new();
        if io::stdin()
            .take(MAX_INPUT_BYTES + 1)
            .read_to_end(&mut input)
            .is_ok()
            && input.len() as u64 <= MAX_INPUT_BYTES
        {
            if let Ok(payload) = serde_json::from_slice::<Value>(&input) {
                let pane_id = std::env::var("CLAWTAB_SESSION_ID")
                    .or_else(|_| std::env::var("TMUX_PANE"))
                    .ok();
                #[cfg(unix)]
                let process_id = Some(unsafe { libc::getppid() as u32 });
                #[cfg(not(unix))]
                let process_id = None;
                if let Some(event) = HookEventV1::from_provider_payload(
                    provider, event_name, &payload, pane_id, process_id,
                ) {
                    let _ = write_event(&event);
                }
            }
        }
    }
    if antigravity {
        print!("{{}}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hermes_long_history_is_streamed_without_retaining_content() {
        let input = serde_json::json!({"session_id":"session", "cwd":"private", "extra":{"kind":"approval", "messages":[{"content":"x".repeat(512 * 1024)}]}, "tool_input":{"command":"private"}}).to_string();
        let payload: HermesPayload = serde_json::from_reader(input.as_bytes()).unwrap();
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({"session_id":"session", "extra":{"kind":"approval"}})
        );
    }

    #[test]
    fn hermes_malformed_or_truncated_hook_payload_is_rejected() {
        for input in ["{", "{}", r#"{"session_id":"session","extra":"wrong"}"#] {
            assert!(serde_json::from_reader::<_, HermesPayload>(input.as_bytes()).is_err());
        }
    }
}
