use std::io::Cursor;

use a2::{
    Client, ClientConfig, DefaultNotificationBuilder, Endpoint, NotificationBuilder,
    NotificationOptions, Priority, PushType,
};
use serde::Serialize;

use crate::config::Config;

pub struct ApnsClient {
    production: Client,
    sandbox: Client,
    topic: String,
}

#[derive(Serialize)]
struct QuestionPayload {
    question_id: String,
    pane_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    matched_job: Option<String>,
    options: Vec<PayloadOption>,
}

#[derive(Serialize)]
struct PayloadOption {
    number: String,
    label: String,
}

#[derive(Serialize)]
struct JobPayload {
    job_id: String,
    run_id: String,
}

/// Result of a single APNs send attempt.
enum SendResult {
    Ok,
    /// Token is invalid for this environment (400/410) - worth retrying on the other.
    BadToken,
    /// Non-recoverable error.
    Fatal(String),
}

fn classify_send_result(result: Result<a2::Response, a2::Error>) -> SendResult {
    match result {
        Ok(_) => SendResult::Ok,
        Err(a2::Error::ResponseError(response)) => {
            if response.code == 400 || response.code == 410 {
                SendResult::BadToken
            } else {
                if response.code == 403 {
                    tracing::error!(
                        "APNs 403 InvalidProviderToken - check: \
                         (1) APNS_KEY_ID matches the key ID in Apple Developer Console, \
                         (2) APNS_TEAM_ID matches your Apple Developer Team ID, \
                         (3) the .p8 file is the correct key for this key ID"
                    );
                }
                SendResult::Fatal(format!(
                    "APNs error {}: {:?}",
                    response.code, response.error
                ))
            }
        }
        Err(e) => SendResult::Fatal(format!("APNs send error: {e}")),
    }
}

impl ApnsClient {
    pub fn new(config: &Config) -> Result<Self, String> {
        let key_path = config
            .apns_key_path
            .as_ref()
            .ok_or("APNS_KEY_PATH not set")?;
        let key_id = config.apns_key_id.as_ref().ok_or("APNS_KEY_ID not set")?;
        let team_id = config
            .apns_team_id
            .as_ref()
            .ok_or("APNS_TEAM_ID not set")?;

        let topic = config
            .apns_topic
            .clone()
            .unwrap_or_else(|| "cc.clawtab".to_string());

        let key_bytes = std::fs::read(key_path)
            .map_err(|e| format!("failed to read APNs key at {key_path}: {e}"))?;

        let key_str = String::from_utf8_lossy(&key_bytes);
        if !key_str.contains("BEGIN PRIVATE KEY") {
            return Err(
                "APNs .p8 file does not contain 'BEGIN PRIVATE KEY' - must be PKCS#8 PEM format"
                    .to_string(),
            );
        }

        let production = Client::token(
            &mut Cursor::new(&key_bytes),
            key_id,
            team_id,
            ClientConfig::new(Endpoint::Production),
        )
        .map_err(|e| format!("failed to create APNs production client: {e}"))?;

        let sandbox = Client::token(
            &mut Cursor::new(&key_bytes),
            key_id,
            team_id,
            ClientConfig::new(Endpoint::Sandbox),
        )
        .map_err(|e| format!("failed to create APNs sandbox client: {e}"))?;

        tracing::info!(
            "APNs config: key_id={key_id} team_id={team_id} topic={topic} endpoints=production+sandbox key_path={key_path}"
        );

        Ok(Self {
            production,
            sandbox,
            topic,
        })
    }

    pub async fn send_job_notification(
        &self,
        device_token: &str,
        job_id: &str,
        event: &str,
        run_id: &str,
    ) -> Result<(), String> {
        let title = "ClawTab";
        let body = format!("Job {} {}", job_id, event);

        let custom_data = JobPayload {
            job_id: job_id.to_string(),
            run_id: run_id.to_string(),
        };
        let custom_json =
            serde_json::to_value(&custom_data).map_err(|e| format!("json error: {e}"))?;

        let build_payload = || {
            let builder = DefaultNotificationBuilder::new()
                .set_title(title)
                .set_body(&body)
                .set_sound("default");

            let options_obj = NotificationOptions {
                apns_id: None,
                apns_expiration: None,
                apns_priority: Some(Priority::High),
                apns_topic: Some(&self.topic),
                apns_collapse_id: None,
                apns_push_type: Some(PushType::Alert),
            };

            let mut payload = builder.build(device_token, options_obj);
            payload.add_custom_data("clawtab", &custom_json).ok();
            payload
        };

        // Try production first
        match classify_send_result(self.production.send(build_payload()).await) {
            SendResult::Ok => return Ok(()),
            SendResult::BadToken => {
                tracing::debug!("production rejected token, trying sandbox: {device_token}");
            }
            SendResult::Fatal(e) => return Err(e),
        }

        // Retry on sandbox
        match classify_send_result(self.sandbox.send(build_payload()).await) {
            SendResult::Ok => {
                tracing::debug!("push delivered via sandbox: {device_token}");
                Ok(())
            }
            SendResult::BadToken => Err("invalid_token:both".to_string()),
            SendResult::Fatal(e) => Err(e),
        }
    }

    pub async fn send_question_notification(
        &self,
        device_token: &str,
        title: &str,
        body: &str,
        question_id: &str,
        pane_id: &str,
        matched_job: Option<&str>,
        options: &[(String, String)],
    ) -> Result<(), String> {
        let payload_options: Vec<PayloadOption> = options
            .iter()
            .map(|(n, l)| PayloadOption {
                number: n.clone(),
                label: l.clone(),
            })
            .collect();

        let custom_data = QuestionPayload {
            question_id: question_id.to_string(),
            pane_id: pane_id.to_string(),
            matched_job: matched_job.map(|s| s.to_string()),
            options: payload_options,
        };

        let custom_json =
            serde_json::to_value(&custom_data).map_err(|e| format!("json error: {e}"))?;

        // Pick category based on option count (pre-registered in the iOS app)
        let category = match options.len().min(4) {
            2 => "CLAUDE_Q2",
            3 => "CLAUDE_Q3",
            _ => "CLAUDE_Q4",
        };

        let build_payload = || {
            let builder = DefaultNotificationBuilder::new()
                .set_title(title)
                .set_body(body)
                .set_mutable_content()
                .set_category(category)
                .set_sound("default");

            let options_obj = NotificationOptions {
                apns_id: None,
                apns_expiration: None,
                apns_priority: Some(Priority::High),
                apns_topic: Some(&self.topic),
                apns_collapse_id: None,
                apns_push_type: Some(PushType::Alert),
            };

            let mut payload = builder.build(device_token, options_obj);
            payload.add_custom_data("clawtab", &custom_json).ok();
            payload
        };

        // Try production first
        match classify_send_result(self.production.send(build_payload()).await) {
            SendResult::Ok => return Ok(()),
            SendResult::BadToken => {
                tracing::debug!("production rejected token, trying sandbox: {device_token}");
            }
            SendResult::Fatal(e) => return Err(e),
        }

        // Retry on sandbox
        match classify_send_result(self.sandbox.send(build_payload()).await) {
            SendResult::Ok => {
                tracing::debug!("push delivered via sandbox: {device_token}");
                Ok(())
            }
            SendResult::BadToken => Err("invalid_token:both".to_string()),
            SendResult::Fatal(e) => Err(e),
        }
    }
}
