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

        let mut key_file =
            std::fs::File::open(key_path).map_err(|e| format!("failed to open APNs key: {e}"))?;

        let endpoint = if config.apns_sandbox {
            Endpoint::Sandbox
        } else {
            Endpoint::Production
        };

        let client =
            Client::token(&mut key_file, key_id, team_id, ClientConfig::new(endpoint))
                .map_err(|e| format!("failed to create APNs client: {e}"))?;

        let topic = config
            .apns_topic
            .clone()
            .unwrap_or_else(|| "cc.clawtab".to_string());

        Ok(Self { client, topic })
    }

    pub async fn send_question_notification(
        &self,
        device_token: &str,
        title: &str,
        body: &str,
        question_id: &str,
        pane_id: &str,
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
