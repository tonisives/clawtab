use clawtab_protocol::ClientMessage;
use serde::Serialize;
use uuid::Uuid;

use crate::config::Config;
use crate::error::AppError;

#[derive(Serialize)]
struct DispatchBody<'a> {
    user_id: Uuid,
    device_id: Option<Uuid>,
    message: &'a ClientMessage,
}

pub struct Dispatcher {
    client: reqwest::Client,
    config: std::sync::Arc<Config>,
}

#[derive(Debug)]
pub enum DispatchOutcome {
    Sent,
    NoDevice,
}

impl Dispatcher {
    pub fn new(config: std::sync::Arc<Config>) -> Self {
        Self {
            client: reqwest::Client::new(),
            config,
        }
    }

    pub async fn dispatch(
        &self,
        user_id: Uuid,
        device_id: Option<Uuid>,
        message: &ClientMessage,
    ) -> Result<DispatchOutcome, AppError> {
        let url = format!("{}/_internal/dispatch", self.config.relay_internal_url);
        let body = DispatchBody { user_id, device_id, message };

        let resp = self.client
            .post(&url)
            .header("x-internal-secret", &self.config.relay_internal_secret)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("relay dispatch failed: {e}")))?;

        match resp.status().as_u16() {
            200 | 204 => Ok(DispatchOutcome::Sent),
            404 => Ok(DispatchOutcome::NoDevice),
            code => {
                let text = resp.text().await.unwrap_or_default();
                Err(AppError::Internal(format!("relay returned {code}: {text}")))
            }
        }
    }
}
