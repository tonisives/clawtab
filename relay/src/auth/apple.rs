use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;

use crate::error::AppError;

const APPLE_KEYS_URL: &str = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER: &str = "https://appleid.apple.com";

#[derive(Debug, Deserialize)]
struct AppleJwkSet {
    keys: Vec<AppleJwk>,
}

#[derive(Debug, Deserialize)]
struct AppleJwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Debug, Deserialize)]
struct AppleClaims {
    sub: String,
    email: Option<String>,
    #[serde(default)]
    email_verified: Option<serde_json::Value>,
    #[allow(dead_code)]
    aud: String,
}

pub struct AppleUserInfo {
    pub sub: String,
    pub email: Option<String>,
}

pub async fn verify_apple_token(
    id_token: &str,
    expected_client_id: &str,
) -> Result<AppleUserInfo, AppError> {
    let header = decode_header(id_token)
        .map_err(|e| AppError::BadRequest(format!("invalid apple token header: {e}")))?;

    let kid = header.kid
        .ok_or_else(|| AppError::BadRequest("apple token missing kid".into()))?;

    let keys: AppleJwkSet = reqwest::get(APPLE_KEYS_URL)
        .await
        .map_err(|e| AppError::Internal(format!("failed to fetch apple keys: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("failed to parse apple keys: {e}")))?;

    let jwk = keys.keys.iter().find(|k| k.kid == kid)
        .ok_or_else(|| AppError::BadRequest("apple key not found for kid".into()))?;

    let decoding_key = DecodingKey::from_rsa_components(&jwk.n, &jwk.e)
        .map_err(|e| AppError::Internal(format!("invalid apple key components: {e}")))?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[expected_client_id]);
    validation.set_issuer(&[APPLE_ISSUER]);

    let token_data = decode::<AppleClaims>(id_token, &decoding_key, &validation)
        .map_err(|e| AppError::BadRequest(format!("invalid apple token: {e}")))?;

    let claims = token_data.claims;

    // email_verified can be a bool or string "true"
    let verified = match &claims.email_verified {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => s == "true",
        _ => false,
    };

    let email = if verified { claims.email } else { None };

    Ok(AppleUserInfo {
        sub: claims.sub,
        email,
    })
}
