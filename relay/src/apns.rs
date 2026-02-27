use std::io::Cursor;

use a2::{
    Client, ClientConfig, DefaultNotificationBuilder, Endpoint, NotificationBuilder,
    NotificationOptions, Priority,
};
use serde::Serialize;

use crate::config::Config;

pub struct ApnsClient {
    client: Client,
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

        let endpoint = if config.apns_sandbox {
            Endpoint::Sandbox
        } else {
            Endpoint::Production
        };

        let topic = config
            .apns_topic
            .clone()
            .unwrap_or_else(|| "cc.clawtab".to_string());

        tracing::info!(
            "APNs config: key_id={key_id} team_id={team_id} topic={topic} endpoint={} key_path={key_path}",
            if config.apns_sandbox { "sandbox" } else { "production" }
        );

        let key_bytes = std::fs::read(key_path)
            .map_err(|e| format!("failed to read APNs key at {key_path}: {e}"))?;

        let key_str = String::from_utf8_lossy(&key_bytes);
        if !key_str.contains("BEGIN PRIVATE KEY") {
            return Err(
                "APNs .p8 file does not contain 'BEGIN PRIVATE KEY' - must be PKCS#8 PEM format"
                    .to_string(),
            );
        }

        let mut cursor = Cursor::new(key_bytes);
        let client =
            Client::token(&mut cursor, key_id, team_id, ClientConfig::new(endpoint))
                .map_err(|e| format!("failed to create APNs client: {e}"))?;

        Ok(Self { client, topic })
    }

    pub async fn send_job_notification(
        &self,
        device_token: &str,
        job_name: &str,
        event: &str,
    ) -> Result<(), String> {
        let title = "ClawTab";
        let body = format!("Job {} {}", job_name, event);

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
            apns_push_type: None,
        };

        let payload = builder.build(device_token, options_obj);

        match self.client.send(payload).await {
            Ok(_) => Ok(()),
            Err(a2::Error::ResponseError(response)) => {
                if response.code == 410 || response.code == 400 {
                    Err(format!("invalid_token:{}", response.code))
                } else {
                    Err(format!(
                        "APNs error {}: {:?}",
                        response.code, response.error
                    ))
                }
            }
            Err(e) => Err(format!("APNs send error: {e}")),
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

        let builder = DefaultNotificationBuilder::new()
            .set_title(title)
            .set_body(body)
            .set_mutable_content()
            .set_category("CLAUDE_QUESTION")
            .set_sound("default");

        let options_obj = NotificationOptions {
            apns_id: None,
            apns_expiration: None,
            apns_priority: Some(Priority::High),
            apns_topic: Some(&self.topic),
            apns_collapse_id: None,
            apns_push_type: None,
        };

        let mut payload = builder.build(device_token, options_obj);
        payload
            .add_custom_data("clawtab", &custom_json)
            .map_err(|e| format!("custom data error: {e}"))?;

        match self.client.send(payload).await {
            Ok(_) => Ok(()),
            Err(a2::Error::ResponseError(response)) => {
                if response.code == 410 || response.code == 400 {
                    Err(format!("invalid_token:{}", response.code))
                } else if response.code == 403 {
                    tracing::error!(
                        "APNs 403 InvalidProviderToken - check: \
                         (1) APNS_KEY_ID matches the key ID in Apple Developer Console, \
                         (2) APNS_TEAM_ID matches your Apple Developer Team ID, \
                         (3) the .p8 file is the correct key for this key ID"
                    );
                    Err(format!(
                        "APNs error 403: {:?} (likely JWT auth misconfiguration)",
                        response.error
                    ))
                } else {
                    Err(format!(
                        "APNs error {}: {:?}",
                        response.code, response.error
                    ))
                }
            }
            Err(e) => Err(format!("APNs send error: {e}")),
        }
    }
}
