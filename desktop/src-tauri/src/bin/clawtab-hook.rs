use clawtab_lib::agent_hooks::{write_event, HookEventV1};
use clawtab_lib::agent_session::ProcessProvider;
use serde_json::Value;
use std::io::{self, Read};

const MAX_INPUT_BYTES: u64 = 256 * 1024;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let provider = args
        .get(1)
        .and_then(|value| ProcessProvider::from_name(value));
    let event_name = args.get(2).map(String::as_str);
    let antigravity = provider == Some(ProcessProvider::Antigravity);
    if let (Some(provider), Some(event_name)) = (provider, event_name) {
        let mut input = Vec::new();
        if io::stdin()
            .take(MAX_INPUT_BYTES + 1)
            .read_to_end(&mut input)
            .is_ok()
            && input.len() as u64 <= MAX_INPUT_BYTES
        {
            if let Ok(payload) = serde_json::from_slice::<Value>(&input) {
                let pane_id = std::env::var("TMUX_PANE").ok();
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
