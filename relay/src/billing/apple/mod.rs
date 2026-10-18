use app_store_server_library::{
    models::{
        app_store_environment::Environment, auto_renew_status::AutoRenewStatus,
        jws_transaction_decoded_payload::JWSTransactionDecodedPayload, product_type::ProductType,
    },
    signed_data_verifier::{SignedDataVerifier, SignedDataVerifierError},
};
use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

const APP_APPLE_ID: i64 = 6_759_683_841;
// https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// SHA-256: 63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179
const APPLE_ROOT: &[u8] = include_bytes!("AppleRootCA-G3.cer");
const MAX_SIGNED_DATA_BYTES: usize = 65_536;

#[derive(Debug, thiserror::Error)]
#[error("Apple signed purchase data could not be verified")]
pub struct VerificationError;

// No Debug/Serialize: signed data and account identifiers must not enter logs.
pub struct VerifiedTransaction {
    pub transaction_id: String,
    pub original_transaction_id: String,
    pub product_id: String,
    pub environment: &'static str,
    pub purchase_date: DateTime<Utc>,
    pub expires_date: DateTime<Utc>,
    pub signed_date: DateTime<Utc>,
    pub revocation_date: Option<DateTime<Utc>>,
    pub is_upgraded: bool,
    pub app_account_token: Option<Uuid>,
}

impl VerifiedTransaction {
    pub fn belongs_to(&self, user_id: Uuid) -> bool {
        self.app_account_token.is_none_or(|token| token == user_id)
    }

    #[cfg(test)]
    pub fn active_at(&self, now: DateTime<Utc>) -> bool {
        self.revocation_date.is_none() && !self.is_upgraded && self.expires_date > now
    }
}

pub struct VerifiedNotification {
    pub signed_date: DateTime<Utc>,
    pub renewal_signed_date: Option<DateTime<Utc>>,
    pub grace_period_expires_date: Option<DateTime<Utc>>,
    pub id: String,
    pub notification_type: String,
    pub environment: &'static str,
    pub transaction: Option<VerifiedTransaction>,
    pub auto_renew: Option<bool>,
}

fn verifier(
    roots: &[Vec<u8>],
    environment: Environment,
    bundle_id: &str,
) -> Result<SignedDataVerifier, VerificationError> {
    // Verify historical signatures at their signed date, as supported by Apple's
    // libraries. Subscription expiry is checked separately before granting access.
    SignedDataVerifier::new(
        roots.to_vec(),
        environment,
        bundle_id.to_owned(),
        Some(APP_APPLE_ID),
        false,
    )
    .map_err(|_| VerificationError)
}

fn verify_in_store_environment<T>(
    signed: &str,
    bundle_id: &str,
    roots: &[Vec<u8>],
    verify: impl Fn(&SignedDataVerifier, &str) -> Result<T, SignedDataVerifierError>,
) -> Result<(T, SignedDataVerifier), VerificationError> {
    if signed.is_empty() || signed.len() > MAX_SIGNED_DATA_BYTES {
        return Err(VerificationError);
    }
    let sandbox = verifier(roots, Environment::Sandbox, bundle_id)?;
    match verify(&sandbox, signed) {
        Ok(value) => Ok((value, sandbox)),
        Err(SignedDataVerifierError::InvalidEnvironment) => {
            let production = verifier(roots, Environment::Production, bundle_id)?;
            let value = verify(&production, signed).map_err(|_| VerificationError)?;
            Ok((value, production))
        }
        Err(_) => Err(VerificationError),
    }
}

fn nonempty(value: Option<String>) -> Result<String, VerificationError> {
    value
        .filter(|value| !value.is_empty())
        .ok_or(VerificationError)
}

fn normalize_transaction(
    value: JWSTransactionDecodedPayload,
) -> Result<VerifiedTransaction, VerificationError> {
    if value.r#type != Some(ProductType::AutoRenewableSubscription)
        || value.product_id.as_deref() != Some("cc.clawtab.pro.monthly")
    {
        return Err(VerificationError);
    }
    let environment = match value.environment {
        Some(Environment::Production) => "Production",
        Some(Environment::Sandbox) => "Sandbox",
        _ => return Err(VerificationError),
    };
    let purchase_date = value.purchase_date.ok_or(VerificationError)?;
    let expires_date = value.expires_date.ok_or(VerificationError)?;
    let signed_date = value.signed_date.ok_or(VerificationError)?;
    if expires_date <= purchase_date || signed_date > Utc::now() + Duration::minutes(5) {
        return Err(VerificationError);
    }
    Ok(VerifiedTransaction {
        transaction_id: nonempty(value.transaction_id)?,
        original_transaction_id: nonempty(value.original_transaction_id)?,
        product_id: nonempty(value.product_id)?,
        environment,
        purchase_date,
        expires_date,
        signed_date,
        revocation_date: value.revocation_date,
        is_upgraded: value.is_upgraded.unwrap_or(false),
        app_account_token: value.app_account_token,
    })
}

pub fn verify_transaction(
    signed: &str,
    bundle_id: &str,
) -> Result<VerifiedTransaction, VerificationError> {
    verify_transaction_with_roots(signed, bundle_id, &[APPLE_ROOT.to_vec()])
}

fn verify_transaction_with_roots(
    signed: &str,
    bundle_id: &str,
    roots: &[Vec<u8>],
) -> Result<VerifiedTransaction, VerificationError> {
    let (value, _) = verify_in_store_environment(
        signed,
        bundle_id,
        roots,
        SignedDataVerifier::verify_and_decode_signed_transaction,
    )?;
    normalize_transaction(value)
}

pub fn verify_notification(
    signed: &str,
    bundle_id: &str,
) -> Result<VerifiedNotification, VerificationError> {
    verify_notification_with_roots(signed, bundle_id, &[APPLE_ROOT.to_vec()])
}

fn verify_notification_with_roots(
    signed: &str,
    bundle_id: &str,
    roots: &[Vec<u8>],
) -> Result<VerifiedNotification, VerificationError> {
    let (value, verifier) = verify_in_store_environment(
        signed,
        bundle_id,
        roots,
        SignedDataVerifier::verify_and_decode_notification,
    )?;
    let signed_date = value.signed_date.ok_or(VerificationError)?;
    if signed_date > Utc::now() + Duration::minutes(5) {
        return Err(VerificationError);
    }
    let data = value.data.ok_or(VerificationError)?;
    let environment = match data.environment {
        Some(Environment::Production) => "Production",
        Some(Environment::Sandbox) => "Sandbox",
        _ => return Err(VerificationError),
    };
    let transaction = data
        .signed_transaction_info
        .as_deref()
        .map(|signed| {
            let transaction = verifier
                .verify_and_decode_signed_transaction(signed)
                .map_err(|_| VerificationError)?;
            normalize_transaction(transaction)
        })
        .transpose()?;
    let renewal = data
        .signed_renewal_info
        .as_deref()
        .map(|signed| {
            verifier
                .verify_and_decode_renewal_info(signed)
                .map_err(|_| VerificationError)
        })
        .transpose()?;
    if let (Some(transaction), Some(renewal)) = (&transaction, &renewal) {
        if renewal.original_transaction_id.as_deref()
            != Some(transaction.original_transaction_id.as_str())
        {
            return Err(VerificationError);
        }
    }
    let notification_type = serde_json::to_value(value.notification_type.ok_or(VerificationError)?)
        .map_err(|_| VerificationError)?;
    Ok(VerifiedNotification {
        id: nonempty(value.notification_uuid)?,
        notification_type: notification_type
            .as_str()
            .ok_or(VerificationError)?
            .to_owned(),
        environment,
        transaction,
        signed_date: value.signed_date.ok_or(VerificationError)?,
        renewal_signed_date: renewal.as_ref().and_then(|value| value.signed_date),
        grace_period_expires_date: renewal
            .as_ref()
            .and_then(|value| value.grace_period_expires_date),
        auto_renew: renewal.and_then(|value| match value.auto_renew_status {
            Some(AutoRenewStatus::On) => Some(true),
            Some(AutoRenewStatus::Off) => Some(false),
            _ => None,
        }),
    })
}

#[cfg(test)]
mod tests;
