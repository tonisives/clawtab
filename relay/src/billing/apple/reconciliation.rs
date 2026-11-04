use std::{env, time::Duration};

use chrono::Utc;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::routes::iap::persist_status;

const BUNDLE_ID: &str = "cc.clawtab";

struct Client {
    issuer: String,
    key_id: String,
    key: EncodingKey,
    http: reqwest::Client,
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    iat: i64,
    exp: i64,
    aud: &'static str,
    bid: &'static str,
}

#[derive(Deserialize)]
struct StatusResponse {
    data: Vec<Group>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    last_transactions: Vec<SignedStatus>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedStatus {
    signed_transaction_info: String,
    signed_renewal_info: String,
}

impl Client {
    fn from_env() -> anyhow::Result<Option<Self>> {
        let issuer = env::var("APPLE_IAP_ISSUER_ID").ok();
        let key_id = env::var("APPLE_IAP_KEY_ID").ok();
        let pem = env::var("APPLE_IAP_PRIVATE_KEY").ok();
        if issuer.is_none() && key_id.is_none() && pem.is_none() {
            tracing::warn!("Apple subscription reconciliation disabled: In-App Purchase API credentials are unset");
            return Ok(None);
        }
        let (Some(issuer), Some(key_id), Some(pem)) = (issuer, key_id, pem) else {
            anyhow::bail!(
                "Apple reconciliation requires all three In-App Purchase API credentials"
            );
        };
        Ok(Some(Self {
            issuer,
            key_id,
            key: EncodingKey::from_ec_pem(pem.replace("\\n", "\n").as_bytes())?,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()?,
        }))
    }

    async fn status(
        &self,
        environment: &str,
        original: &str,
    ) -> anyhow::Result<super::VerifiedNotification> {
        let now = Utc::now().timestamp();
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(self.key_id.clone());
        let token = encode(
            &header,
            &Claims {
                iss: &self.issuer,
                iat: now,
                exp: now + 300,
                aud: "appstoreconnect-v1",
                bid: BUNDLE_ID,
            },
            &self.key,
        )?;
        let host = match environment {
            "Sandbox" => "https://api.storekit-sandbox.apple.com",
            "Production" => "https://api.storekit.apple.com",
            _ => anyhow::bail!("Invalid stored Apple environment"),
        };
        let response = self
            .http
            .get(format!(
                "{host}/inApps/v1/subscriptions/{}",
                urlencoding::encode(original)
            ))
            .bearer_auth(token)
            .send()
            .await?
            .error_for_status()?;
        let data: StatusResponse = response.json().await?;
        for signed in data
            .data
            .into_iter()
            .flat_map(|group| group.last_transactions)
        {
            let status = super::verify_status(
                &signed.signed_transaction_info,
                &signed.signed_renewal_info,
                BUNDLE_ID,
            )?;
            if status.transaction.as_ref().is_some_and(|transaction| {
                transaction.environment == environment
                    && transaction.original_transaction_id == original
            }) {
                return Ok(status);
            }
        }
        anyhow::bail!("Apple response omitted the stored subscription")
    }

    async fn reconcile(&self, pool: &PgPool) -> anyhow::Result<()> {
        // Claim work atomically across relay replicas. HTTP failures retain saved
        // access and retry after the same cooldown; no billing dates are changed.
        let rows = claim_due(pool).await?;
        for (environment, original, user) in rows {
            let result = async {
                let status = self.status(&environment, &original).await?;
                anyhow::ensure!(
                    status
                        .transaction
                        .as_ref()
                        .is_some_and(|value| value.belongs_to(user)),
                    "Apple account conflict"
                );
                let mut tx = pool.begin().await?;
                persist_status(&mut tx, status).await?;
                tx.commit().await?;
                Ok::<(), anyhow::Error>(())
            }
            .await;
            if result.is_err() {
                // Errors may contain request URLs and transaction IDs.
                tracing::warn!(stage = "apple-reconciliation-failed");
            }
        }
        Ok(())
    }
}

pub(crate) async fn claim_due(pool: &PgPool) -> Result<Vec<(String, String, Uuid)>, sqlx::Error> {
    sqlx::query_as(
        "WITH due AS (SELECT environment,original_transaction_id FROM apple_subscriptions \
         WHERE apple_checked_at IS NULL OR apple_checked_at < now() - \
           CASE WHEN expires_date > now()-interval '7 days' THEN interval '5 minutes' ELSE interval '1 day' END \
         ORDER BY apple_checked_at NULLS FIRST LIMIT 20 FOR UPDATE SKIP LOCKED) \
         UPDATE apple_subscriptions s SET apple_checked_at=now() FROM due \
         WHERE s.environment=due.environment AND s.original_transaction_id=due.original_transaction_id \
         RETURNING s.environment,s.original_transaction_id,s.user_id"
    ).fetch_all(pool).await
}

pub fn spawn(pool: PgPool) -> anyhow::Result<()> {
    let Some(client) = Client::from_env()? else {
        return Ok(());
    };
    tracing::info!(stage = "apple-reconciliation-enabled");
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if client.reconcile(&pool).await.is_err() {
                tracing::warn!(stage = "apple-reconciliation-query-failed");
            }
        }
    });
    Ok(())
}
