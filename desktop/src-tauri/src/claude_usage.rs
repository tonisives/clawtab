use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageBucket {
    pub utilization: f64,
    pub resets_at: Option<String>,
}

impl UsageBucket {
    pub fn resets_in_human(&self) -> Option<String> {
        let raw = self.resets_at.as_ref()?;
        let target = raw.parse::<DateTime<Utc>>().ok()?;
        let delta = target - Utc::now();
        if delta.num_seconds() <= 0 {
            return Some("now".to_string());
        }
        let hours = delta.num_hours();
        let minutes = delta.num_minutes();
        if hours >= 24 {
            let days = hours / 24;
            let rem_hours = hours % 24;
            if rem_hours == 0 {
                Some(format!("in {}d", days))
            } else {
                Some(format!("in {}d {}h", days, rem_hours))
            }
        } else if hours >= 1 {
            let rem_min = minutes % 60;
            if rem_min == 0 {
                Some(format!("in {}h", hours))
            } else {
                Some(format!("in {}h {}m", hours, rem_min))
            }
        } else {
            Some(format!("in {}m", minutes.max(1)))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageResponse {
    pub five_hour: Option<UsageBucket>,
    pub seven_day: Option<UsageBucket>,
}

fn read_oauth_token() -> Result<String, String> {
    let output = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map_err(|e| format!("failed to run security command: {}", e))?;

    if !output.status.success() {
        return Err("no Claude Code credentials found in keychain".to_string());
    }

    let json_str = String::from_utf8(output.stdout)
        .map_err(|e| format!("invalid utf8 from keychain: {}", e))?;
    let json_str = json_str.trim();

    let parsed: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("failed to parse credentials: {}", e))?;

    parsed["claudeAiOauth"]["accessToken"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "accessToken not found in credentials".to_string())
}

pub async fn fetch_usage() -> Result<UsageResponse, String> {
    let token = read_oauth_token()?;

    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("usage request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("usage API returned {}", resp.status()));
    }

    resp.json::<UsageResponse>()
        .await
        .map_err(|e| format!("failed to parse usage response: {}", e))
}
