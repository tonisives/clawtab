use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Html;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;

use crate::auth::google::verify_google_token;
use crate::error::AppError;
use crate::routes::google_auth::authenticate_google_user;
use crate::AppState;

#[derive(Deserialize)]
pub struct CallbackParams {
    code: String,
    state: Option<String>,
}

#[derive(Deserialize)]
struct GoogleTokenResponse {
    id_token: String,
}

fn redirect_page(deep_link: &str) -> Html<String> {
    Html(format!(
        r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ClawTab - Sign In</title>
<style>
  body {{ font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0;
         display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }}
  .card {{ text-align: center; padding: 40px; }}
  h2 {{ margin: 0 0 8px; font-size: 20px; }}
  p {{ color: #888; font-size: 14px; margin: 0 0 24px; }}
  a {{ display: inline-block; padding: 10px 24px; background: #2563eb; color: white;
       border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; }}
  a:hover {{ background: #1d4ed8; }}
</style></head>
<body><div class="card">
  <h2>Sign-in successful</h2>
  <p>If ClawTab didn't open automatically, click below.</p>
  <a href="{deep_link}">Open ClawTab</a>
</div>
<script>window.location.href = {deep_link_js};</script>
</body></html>"#,
        deep_link = deep_link,
        deep_link_js = serde_json::to_string(deep_link).unwrap_or_default(),
    ))
}

fn error_page(scheme: &str, error: &str) -> Html<String> {
    let deep_link = format!(
        "{scheme}://auth/callback?error={}",
        urlencoding::encode(error)
    );
    Html(format!(
        r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ClawTab - Error</title>
<style>
  body {{ font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0;
         display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }}
  .card {{ text-align: center; padding: 40px; }}
  h2 {{ margin: 0 0 8px; font-size: 20px; color: #ef4444; }}
  p {{ color: #888; font-size: 14px; margin: 0 0 24px; }}
  a {{ display: inline-block; padding: 10px 24px; background: #333; color: white;
       border-radius: 8px; text-decoration: none; font-size: 14px; }}
</style></head>
<body><div class="card">
  <h2>Sign-in failed</h2>
  <p>{error}</p>
  <a href="{deep_link}">Return to ClawTab</a>
</div></body></html>"#,
    ))
}

/// GET /auth/google/callback - handles the OAuth redirect from Google.
///
/// Exchanges the authorization code for an id_token, authenticates the user,
/// then returns an HTML page that redirects to the deep link scheme with tokens.
pub async fn google_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CallbackParams>,
) -> Result<Html<String>, AppError> {
    // Decode the redirect scheme from the state parameter
    let scheme = params
        .state
        .as_deref()
        .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| "clawtab".into());

    let client_id = state
        .config
        .google_client_id
        .as_deref()
        .ok_or_else(|| AppError::Internal("GOOGLE_CLIENT_ID not configured".into()))?;

    let client_secret = state
        .config
        .google_client_secret
        .as_deref()
        .ok_or_else(|| AppError::Internal("GOOGLE_CLIENT_SECRET not configured".into()))?;

    // Reconstruct the redirect_uri from the Host header (must match what the client sent to Google)
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("relay.clawtab.cc");
    let redirect_uri = format!("https://{host}/auth/google/callback");

    // Exchange the authorization code for tokens
    let token_resp = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", params.code.as_str()),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", &redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("google token exchange failed: {e}")))?;

    if !token_resp.status().is_success() {
        let body = token_resp.text().await.unwrap_or_default();
        tracing::error!("google token exchange error: {body}");
        return Ok(error_page(&scheme, "Failed to exchange authorization code"));
    }

    let tokens: GoogleTokenResponse = token_resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("failed to parse google token response: {e}")))?;

    // Verify the id_token
    let info = match verify_google_token(&tokens.id_token, Some(client_id)).await {
        Ok(info) => info,
        Err(e) => {
            tracing::error!("google token verification failed: {e}");
            return Ok(error_page(&scheme, "Google authentication failed"));
        }
    };

    // Authenticate (find or create user, issue tokens)
    let auth = match authenticate_google_user(&state, &info).await {
        Ok(auth) => auth,
        Err(e) => {
            tracing::error!("google user authentication failed: {e}");
            return Ok(error_page(&scheme, "Authentication failed"));
        }
    };

    let deep_link = format!(
        "{scheme}://auth/callback?access_token={}&refresh_token={}&user_id={}",
        urlencoding::encode(&auth.access_token),
        urlencoding::encode(&auth.refresh_token),
        auth.user_id,
    );

    Ok(redirect_page(&deep_link))
}
