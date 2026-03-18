use axum::extract::State;
use axum::response::Html;
use axum::Form;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;

use crate::auth::apple::verify_apple_token;
use crate::error::AppError;
use crate::routes::apple_auth::authenticate_apple_user;
use crate::AppState;

#[derive(Deserialize)]
pub struct AppleCallbackParams {
    /// Apple sends the id_token directly when response_type includes id_token
    id_token: Option<String>,
    /// The authorization code (if response_type includes code)
    code: Option<String>,
    /// We encode the deep-link scheme in the state param
    state: Option<String>,
    /// User info JSON (only on first sign-in, Apple sends as form field)
    user: Option<String>,
}

#[derive(Deserialize)]
struct AppleUserPayload {
    name: Option<AppleUserName>,
    email: Option<String>,
}

#[derive(Deserialize)]
struct AppleUserName {
    #[serde(rename = "firstName")]
    first_name: Option<String>,
    #[serde(rename = "lastName")]
    last_name: Option<String>,
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

/// POST /auth/apple/callback - handles the OAuth redirect from Apple.
///
/// Apple sends a form POST with id_token and optional user info.
/// We verify the token, authenticate the user, then redirect via deep link.
pub async fn apple_callback(
    State(state): State<AppState>,
    Form(params): Form<AppleCallbackParams>,
) -> Result<Html<String>, AppError> {
    let scheme = params
        .state
        .as_deref()
        .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| "clawtab".into());

    let id_token = match params.id_token {
        Some(t) => t,
        None => {
            tracing::error!("apple callback missing id_token, code={:?}", params.code);
            return Ok(error_page(&scheme, "Apple authentication failed - no token received"));
        }
    };

    // For web flow, use the web client ID (Services ID)
    let apple_client_id = state
        .config
        .apple_web_client_id
        .as_deref()
        .or(state.config.apple_client_id.as_deref())
        .unwrap_or("cc.clawtab");

    let info = match verify_apple_token(&id_token, apple_client_id).await {
        Ok(info) => info,
        Err(e) => {
            tracing::error!("apple token verification failed: {e}");
            return Ok(error_page(&scheme, "Apple authentication failed"));
        }
    };

    // Extract user info from Apple's user field (only sent on first sign-in)
    let (display_name, user_email) = if let Some(ref user_json) = params.user {
        match serde_json::from_str::<AppleUserPayload>(user_json) {
            Ok(u) => {
                let name = u.name.and_then(|n| {
                    let parts: Vec<&str> = [n.first_name.as_deref(), n.last_name.as_deref()]
                        .into_iter()
                        .flatten()
                        .collect();
                    if parts.is_empty() { None } else { Some(parts.join(" ")) }
                });
                (name, u.email)
            }
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    let auth = match authenticate_apple_user(
        &state,
        &info,
        display_name.as_deref(),
        user_email.as_deref(),
    )
    .await
    {
        Ok(auth) => auth,
        Err(e) => {
            tracing::error!("apple user authentication failed: {e}");
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
