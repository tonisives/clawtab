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
                if let Some(output) = task_title_context(provider, event_name, &payload) {
                    print!("{output}");
                }
            }
        }
    }
    if antigravity {
        print!("{{}}");
    }
}

// Reuse the prompt hook; the active agent already understands the task. No
// additional model invocation, transcript read, or background observer is needed.
fn task_title_context(
    provider: ProcessProvider,
    event_name: &str,
    payload: &Value,
) -> Option<Value> {
    if event_name != "user_prompt_submit"
        || !matches!(provider, ProcessProvider::Codex | ProcessProvider::Claude)
        || payload.get("agent_id").and_then(Value::as_str).is_some()
    {
        return None;
    }
    let session_id = payload.get("session_id")?.as_str()?;
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b"-_".contains(&ch))
    {
        return None;
    }
    let prompt = payload.get("prompt")?.as_str()?.trim();
    let acknowledgement = prompt.trim_end_matches(['.', '!']);
    if prompt.chars().take(12).count() < 12
        || [
            "please continue",
            "keep going please",
            "yes please continue",
        ]
        .iter()
        .any(|value| acknowledgement.eq_ignore_ascii_case(value))
        || prompt.starts_with('/')
    {
        return None;
    }
    let context = format!(
        "ClawTab task label: if this request starts a new objective or materially changes the current one, \
         update the short task label once using `cwt agent task-title {} {} \"Short task title\"`. \
         Use your existing understanding of the request; do not inspect transcripts, other agents, or invoke a model for this. \
         Skip acknowledgements, continuation, and refinements of the same task. This updates labels for this conversation \
         across its panes and preserves manual pane names. It does not rename the saved agent conversation.",
        provider.as_str(), session_id
    );
    Some(serde_json::json!({"hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit", "additionalContext": context
    }}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_title_instructions_only_accompany_substantive_parent_prompts() {
        let mut payload =
            serde_json::json!({"session_id":"session-1", "prompt":"Fix the pane routing issue"});
        let output =
            task_title_context(ProcessProvider::Codex, "user_prompt_submit", &payload).unwrap();
        assert!(output["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap()
            .contains("cwt agent task-title codex session-1"));
        assert!(task_title_context(ProcessProvider::Codex, "stop", &payload).is_none());
        assert!(
            task_title_context(ProcessProvider::Hermes, "user_prompt_submit", &payload).is_none()
        );
        for prompt in [
            "continue",
            "please continue",
            "yes please continue.",
            "/rename Something",
        ] {
            payload["prompt"] = prompt.into();
            assert!(
                task_title_context(ProcessProvider::Codex, "user_prompt_submit", &payload)
                    .is_none()
            );
        }
        payload["prompt"] = "Fix the pane routing issue".into();
        payload["agent_id"] = "child-agent".into();
        assert!(
            task_title_context(ProcessProvider::Codex, "user_prompt_submit", &payload).is_none()
        );
        payload.as_object_mut().unwrap().remove("agent_id");
        payload["session_id"] = "session; command".into();
        assert!(
            task_title_context(ProcessProvider::Codex, "user_prompt_submit", &payload).is_none()
        );
    }

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
