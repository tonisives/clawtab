use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub struct ModelCatalog {
    pub models: HashMap<String, Vec<(String, String)>>,
    pub errors: HashMap<String, String>,
}

pub async fn detect_catalog(refresh: bool) -> ModelCatalog {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<(Instant, ModelCatalog)>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await;
    if !refresh {
        if let Some((created, catalog)) = cache.as_ref() {
            if created.elapsed() < Duration::from_secs(300) {
                return catalog.clone();
            }
        }
    }
    let (codex, claude, opencode, antigravity) = tokio::join!(
        detect_installed("codex"),
        detect_installed("claude"),
        detect_installed("opencode"),
        detect_installed("antigravity"),
    );
    let mut catalog = ModelCatalog::default();
    for (provider, result) in [
        ("codex", codex),
        ("claude", claude),
        ("opencode", opencode),
        ("antigravity", antigravity),
    ] {
        match result {
            Ok(Some(models)) => {
                catalog.models.insert(provider.to_string(), models);
            }
            Ok(None) => {}
            Err(error) => {
                catalog.errors.insert(provider.to_string(), error);
            }
        }
    }
    // Keep the last successful catalog if a CLI or provider is temporarily unavailable.
    if let Some((_, previous)) = cache.as_ref() {
        for (provider, models) in &previous.models {
            catalog
                .models
                .entry(provider.clone())
                .or_insert_with(|| models.clone());
        }
    }
    *cache = Some((Instant::now(), catalog.clone()));
    catalog
}

async fn detect_installed(provider: &str) -> Result<Option<Vec<(String, String)>>, String> {
    let binary = if provider == "antigravity" {
        "agy"
    } else {
        provider
    };
    if crate::tools::which(binary).is_none() {
        return Ok(None);
    }
    let models = match provider {
        "codex" => detect_codex_models().await?,
        "claude" => detect_claude_models().await?,
        "opencode" => detect_opencode_models()
            .await?
            .into_iter()
            .map(|id| (id.clone(), id))
            .collect(),
        "antigravity" => detect_antigravity_models().await?,
        _ => return Err("unsupported provider".into()),
    };
    Ok(Some(models))
}

async fn model_command(binary: &str, args: &[&str]) -> Result<std::process::Output, String> {
    // Background hosts may have a minimal PATH. Run the same absolute path
    // found by installation detection, including its standard-bin fallbacks.
    let executable =
        crate::tools::which(binary).ok_or_else(|| format!("{} is not installed", binary))?;
    let output = tokio::time::timeout(
        Duration::from_secs(12),
        tokio::process::Command::new(executable)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| format!("{} model detection timed out", binary))?
    .map_err(|_| format!("failed to run {} model detection", binary))?;
    if !output.status.success() {
        return Err(format!("{} model detection failed", binary));
    }
    Ok(output)
}

/// Fetches available Claude models from the Anthropic API using the stored OAuth token.
/// Returns (model_id, display_name) pairs.
pub async fn detect_claude_models() -> Result<Vec<(String, String)>, String> {
    #[cfg(target_os = "macos")]
    let json_str = {
        let output = model_command(
            "security",
            &[
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ],
        )
        .await?;
        String::from_utf8(output.stdout).map_err(|_| "invalid credential encoding".to_string())?
    };
    #[cfg(not(target_os = "macos"))]
    let json_str = {
        let home = dirs::home_dir().ok_or("home directory unavailable")?;
        std::fs::read_to_string(home.join(".claude/.credentials.json"))
            .map_err(|_| "no Claude Code credentials found".to_string())?
    };
    let parsed: serde_json::Value = serde_json::from_str(json_str.trim())
        .map_err(|e| format!("failed to parse credentials: {}", e))?;
    let token = parsed["claudeAiOauth"]["accessToken"]
        .as_str()
        .ok_or_else(|| "accessToken not found".to_string())?
        .to_string();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.anthropic.com/v1/models")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("API returned {}", resp.status()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("parse error: {}", e))?;
    // The /v1/models endpoint returns the full Anthropic API catalog, but Claude Code's
    // /model command only allows the current latest of each family. Older revisions are
    // listed by the API but cannot be selected in Claude Code, so keep the highest version
    // for each family while still recognizing newly introduced families.
    let mut entries: Vec<(String, String, String, u32, u32)> = body["data"]
        .as_array()
        .ok_or_else(|| "unexpected response shape".to_string())?
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?.to_string();
            let name = m["display_name"].as_str().unwrap_or(&id).to_string();
            let (family, major, minor) = parse_claude_family(&id)?;
            Some((id, name, family.to_string(), major, minor))
        })
        .collect();
    // Sort highest version first
    entries.sort_by(|a, b| b.3.cmp(&a.3).then(b.4.cmp(&a.4)));
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let models: Vec<(String, String)> = entries
        .into_iter()
        .filter_map(|(id, name, family, _, _)| {
            if seen.insert(family) {
                Some((id, name))
            } else {
                None
            }
        })
        .collect();

    Ok(models)
}

/// Parse a Claude model id like "claude-opus-4-7" into ("opus", 4, 7).
/// Returns None for ids that don't match the family pattern.
fn parse_claude_family(id: &str) -> Option<(&'static str, u32, u32)> {
    let stripped = id.strip_prefix("claude-")?;
    let (family, rest) = ["fable", "mythos", "opus", "sonnet", "haiku"]
        .iter()
        .find_map(|family| {
            stripped
                .strip_prefix(&format!("{}-", family))
                .map(|rest| (*family, rest))
        })?;
    let mut parts = rest.split('-');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor = parts
        .next()
        .filter(|part| part.len() <= 2)
        .and_then(|part| part.parse().ok())
        .unwrap_or(0);
    Some((family, major, minor))
}

/// Runs `codex debug models` and returns (slug, display_name) for models that are
/// listable in the CLI picker.
pub async fn detect_codex_models() -> Result<Vec<(String, String)>, String> {
    let output = model_command("codex", &["debug", "models"]).await?;
    let body: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("failed to parse codex models json: {}", e))?;
    parse_codex_models(&body)
}

fn parse_codex_models(body: &serde_json::Value) -> Result<Vec<(String, String)>, String> {
    Ok(body["models"]
        .as_array()
        .ok_or("unexpected response shape: missing models array")?
        .iter()
        .filter(|m| m["visibility"].as_str() == Some("list"))
        .filter_map(|m| {
            let slug = m["slug"].as_str()?.to_string();
            let name = m["display_name"].as_str().unwrap_or(&slug).to_string();
            Some((slug, name))
        })
        .collect())
}

/// Runs `opencode models` and returns the list of available model IDs (e.g. "opencode/big-pickle").
pub async fn detect_opencode_models() -> Result<Vec<String>, String> {
    let output = model_command("opencode", &["models"]).await?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

/// Runs `agy models` (with a timeout) and returns (model_value, display_name) for available models.
/// Antigravity currently prints display-only model names, and those names are also what
/// `agy --model` accepts, so keep the full line as the value in that case.
pub async fn detect_antigravity_models() -> Result<Vec<(String, String)>, String> {
    let result = tokio::time::timeout(
        Duration::from_millis(1500),
        model_command("agy", &["models"]),
    )
    .await;
    if let Ok(Ok(output)) = result {
        let models = parse_antigravity_models_output(&String::from_utf8_lossy(&output.stdout));
        if !models.is_empty() {
            return Ok(models);
        }
    }
    Ok(default_antigravity_models())
}

fn parse_antigravity_models_output(stdout: &str) -> Vec<(String, String)> {
    stdout
        .lines()
        .filter_map(parse_antigravity_model_line)
        .collect()
}

fn parse_antigravity_model_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("Usage:")
        || trimmed.starts_with("Available subcommands:")
        || trimmed.contains("List available models")
    {
        return None;
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    let first = parts.first()?;
    if looks_like_antigravity_model_id(first) && parts.len() > 1 {
        return Some(((*first).to_string(), parts[1..].join(" ")));
    }

    Some((trimmed.to_string(), trimmed.to_string()))
}

fn looks_like_antigravity_model_id(value: &str) -> bool {
    value.starts_with("gemini-")
        || value.starts_with("claude-")
        || value.starts_with("gpt-")
        || value.starts_with("o1")
        || value.starts_with("o3")
        || value.starts_with("o4")
}

fn default_antigravity_models() -> Vec<(String, String)> {
    [
        "Gemini 3.5 Flash (Medium)",
        "Gemini 3.5 Flash (High)",
        "Gemini 3.5 Flash (Low)",
        "Gemini 3.1 Pro (Low)",
        "Gemini 3.1 Pro (High)",
        "Claude Sonnet 4.6 (Thinking)",
        "Claude Opus 4.6 (Thinking)",
        "GPT-OSS 120B (Medium)",
    ]
    .into_iter()
    .map(|model| (model.to_string(), model.to_string()))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::{default_antigravity_models, parse_antigravity_models_output, parse_claude_family};

    #[tokio::test]
    #[ignore = "requires an installed, authenticated Codex CLI"]
    async fn detects_installed_codex_catalog() {
        let models = super::detect_codex_models()
            .await
            .expect("Codex model detection");
        assert!(!models.is_empty());
        assert!(models
            .iter()
            .all(|(id, name)| !id.is_empty() && !name.is_empty()));
    }

    #[test]
    fn codex_catalog_includes_new_listable_models_without_hardcoded_ids() {
        let body = serde_json::json!({"models": [
            {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1 Sol", "visibility": "list"},
            {"slug": "future-model", "visibility": "list"},
            {"slug": "hidden-model", "visibility": "hide"},
            {"display_name": "Missing ID", "visibility": "list"}
        ]});
        assert_eq!(
            super::parse_codex_models(&body).expect("valid catalog"),
            vec![
                ("gpt-6.1-sol".into(), "GPT-6.1 Sol".into()),
                ("future-model".into(), "future-model".into())
            ]
        );
        assert!(super::parse_codex_models(&serde_json::json!({})).is_err());
    }

    #[test]
    fn parses_current_claude_model_families() {
        assert_eq!(parse_claude_family("claude-opus-5"), Some(("opus", 5, 0)));
        assert_eq!(
            parse_claude_family("claude-sonnet-5"),
            Some(("sonnet", 5, 0))
        );
        assert_eq!(parse_claude_family("claude-fable-5"), Some(("fable", 5, 0)));
        assert_eq!(
            parse_claude_family("claude-haiku-4-5-20251001"),
            Some(("haiku", 4, 5))
        );
    }

    #[test]
    fn parses_display_only_antigravity_models() {
        let models = parse_antigravity_models_output(
            "Gemini 3.5 Flash (Medium)\nGemini 3.5 Flash (High)\nClaude Sonnet 4.6 (Thinking)\n",
        );

        assert_eq!(
            models,
            vec![
                (
                    "Gemini 3.5 Flash (Medium)".to_string(),
                    "Gemini 3.5 Flash (Medium)".to_string()
                ),
                (
                    "Gemini 3.5 Flash (High)".to_string(),
                    "Gemini 3.5 Flash (High)".to_string()
                ),
                (
                    "Claude Sonnet 4.6 (Thinking)".to_string(),
                    "Claude Sonnet 4.6 (Thinking)".to_string()
                ),
            ]
        );
    }

    #[test]
    fn still_parses_slug_plus_display_antigravity_models() {
        let models =
            parse_antigravity_models_output("gemini-2.5-flash Gemini 2.5 Flash\nUsage: ignored\n");

        assert_eq!(
            models,
            vec![(
                "gemini-2.5-flash".to_string(),
                "Gemini 2.5 Flash".to_string()
            )]
        );
    }

    #[test]
    fn fallback_antigravity_models_include_gemini_3_5_flash() {
        let models = default_antigravity_models();

        assert!(models
            .iter()
            .any(|(id, name)| id == "Gemini 3.5 Flash (Medium)" && name == id));
    }
}
