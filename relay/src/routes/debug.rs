use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::Claims;
use crate::error::AppError;
use crate::notification_fmt;
use crate::AppState;

use clawtab_protocol::QuestionOption;

#[derive(Deserialize)]
pub struct TestPushRequest {
    pub device_token: String,
}

/// Sends multiple test push notifications covering all formatting scenarios.
/// Each scenario is sent as a separate notification with a 1s delay between them.
pub async fn test_push(
    State(state): State<AppState>,
    _claims: Claims,
    Json(req): Json<TestPushRequest>,
) -> Result<Json<Value>, AppError> {
    let Some(ref apns) = state.apns else {
        return Err(AppError::BadRequest("APNs client not configured".into()));
    };

    let scenarios = build_test_scenarios();
    let mut results = Vec::new();

    for scenario in &scenarios {
        let body = notification_fmt::format_body(&scenario.context_lines, &scenario.options);
        let title = notification_fmt::compact_cwd(&scenario.cwd);

        let push_options: Vec<(String, String)> = scenario
            .options
            .iter()
            .take(4)
            .map(|o| (o.number.clone(), o.label.clone()))
            .collect();

        let question_id = format!("test-{}", scenario.name);

        let result = apns
            .send_question_notification(
                &req.device_token,
                &title,
                &body,
                &question_id,
                "test-pane",
                None,
                &push_options,
            )
            .await;

        let ok = result.is_ok();
        results.push(json!({
            "scenario": scenario.name,
            "title": title,
            "body": body,
            "options_count": push_options.len(),
            "ok": ok,
            "error": result.err(),
        }));

        // Small delay between pushes so they arrive in order
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }

    Ok(Json(json!({
        "ok": true,
        "results": results,
    })))
}

struct TestScenario {
    name: &'static str,
    cwd: String,
    context_lines: String,
    options: Vec<QuestionOption>,
}

fn opt(number: &str, label: &str) -> QuestionOption {
    QuestionOption {
        number: number.to_string(),
        label: label.to_string(),
    }
}

fn build_test_scenarios() -> Vec<TestScenario> {
    vec![
        // 1. Yes/No - short options on single line
        TestScenario {
            name: "yes_no",
            cwd: "/Users/tonis/workspace/tgs/clawtab/public".into(),
            context_lines: "Do you want to proceed with the changes?\n\n\u{203A} 1. Yes\n  2. No".into(),
            options: vec![opt("1", "Yes"), opt("2", "No")],
        },
        // 2. France - 6 options, short labels + long labels mixed
        TestScenario {
            name: "france_6opts",
            cwd: "/Users/tonis/workspace/tgs/clawtab/public".into(),
            context_lines: "Geography\n\nWhat is the capital of France?\n\n\u{203A} 1. Paris\n   The City of Light, located in northern France\n  2. Lyon\n   Second-largest city, known for cuisine\n  3. Marseille\n   Port city on the Mediterranean coast\n  4. Bordeaux\n   Wine region capital in southwestern France\n  5. Type something.\n  6. Chat about this".into(),
            options: vec![
                opt("1", "Paris"),
                opt("2", "Lyon"),
                opt("3", "Marseille"),
                opt("4", "Bordeaux"),
                opt("5", "Type something."),
                opt("6", "Chat about this"),
            ],
        },
        // 3. Tool permission - medium options
        TestScenario {
            name: "tool_permission",
            cwd: "/Users/tonis/workspace/tgs/clawtab/public/relay".into(),
            context_lines: "Claude wants to run the following command:\n\n  rm -rf /tmp/build-cache\n\nAllow this action?\n\n\u{203A} 1. Allow once\n  2. Allow always\n  3. Deny".into(),
            options: vec![
                opt("1", "Allow once"),
                opt("2", "Allow always"),
                opt("3", "Deny"),
            ],
        },
        // 4. Long option labels
        TestScenario {
            name: "long_options",
            cwd: "/Users/tonis/dev/myapp".into(),
            context_lines: "Which approach should we use for authentication?\n\n\u{203A} 1. Refactor to use JWT tokens\n  2. Keep session-based auth with rate limiting\n  3. Switch to OAuth2 with Google".into(),
            options: vec![
                opt("1", "Refactor to use JWT tokens"),
                opt("2", "Keep session-based auth with rate limiting"),
                opt("3", "Switch to OAuth2 with Google"),
            ],
        },
        // 5. Short options only - all fit on one line
        TestScenario {
            name: "short_3opts",
            cwd: "/Users/tonis/workspace/tgs/clawtab/public".into(),
            context_lines: "Save changes before closing?\n\n\u{203A} 1. Save\n  2. Discard\n  3. Cancel".into(),
            options: vec![
                opt("1", "Save"),
                opt("2", "Discard"),
                opt("3", "Cancel"),
            ],
        },
        // 6. 4 options exactly (max buttons)
        TestScenario {
            name: "four_options",
            cwd: "/Users/tonis/workspace/tgs/clawtab/public".into(),
            context_lines: "How should we handle this error?\n\n\u{203A} 1. Retry\n  2. Skip\n  3. Abort\n  4. Ignore".into(),
            options: vec![
                opt("1", "Retry"),
                opt("2", "Skip"),
                opt("3", "Abort"),
                opt("4", "Ignore"),
            ],
        },
        // 7. SSR question with breadcrumb artifacts (real-world scenario)
        TestScenario {
            name: "ssr_breadcrumbs",
            cwd: "/Users/tonis/workspace/tgs/defi-jobs".into(),
            context_lines: "Read 5 files (ctrl+o to expand)\n\nNow I have a very thorough understanding. Before writing the plan, I have a few questions to clarify scope.\n\n\u{2190} \u{25A1} SSR goal  \u{25A1} Architecture  \u{25A1} Hydration  \u{2714} Submit  \u{2192}\n\nWhat's the primary goal for moving to SSR? Is it SEO (replacing the prerender service), faster initial page loads, or both?\n\n\u{203A} 1. SEO (replace prerender)\n   Eliminate the prerender service dependency\n  2. Both SEO + performance\n   Better SEO and faster initial paint\n  3. Full SSR for all pages\n   Every page server-rendered\n  4. Type something.\n  5. Chat about this\n  6. Skip interview and plan immediately".into(),
            options: vec![
                opt("1", "SEO (replace prerender)"),
                opt("2", "Both SEO + performance"),
                opt("3", "Full SSR for all pages"),
                opt("4", "Type something."),
                opt("5", "Chat about this"),
                opt("6", "Skip interview and plan immediately"),
            ],
        },
    ]
}
