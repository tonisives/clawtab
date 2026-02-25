use serde::Deserialize;

use crate::error::AppError;

#[derive(Debug, Deserialize)]
pub struct GoogleTokenInfo {
    pub sub: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email_verified: Option<String>,
    pub aud: Option<String>,
}

pub struct GoogleUserInfo {
    pub sub: String,
    pub email: String,
    pub name: Option<String>,
}

pub async fn verify_google_token(
    id_token: &str,
    expected_client_id: Option<&str>,
) -> Result<GoogleUserInfo, AppError> {
    let url = format!(
        "https://oauth2.googleapis.com/tokeninfo?id_token={}",
        id_token
    );

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| AppError::Internal(format!("google token verification request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::BadRequest("invalid google id token".into()));
    }

    let info: GoogleTokenInfo = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("failed to parse google token response: {e}")))?;

    if let Some(expected) = expected_client_id {
        if info.aud.as_deref() != Some(expected) {
            return Err(AppError::BadRequest("google token audience mismatch".into()));
        }
    }

    if info.email_verified.as_deref() != Some("true") {
        return Err(AppError::BadRequest("google email not verified".into()));
    }

    Ok(GoogleUserInfo {
        sub: info.sub,
        email: info.email,
        name: info.name,
    })
}
