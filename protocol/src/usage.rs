use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEntry {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderUsageSnapshot {
    pub provider: String,
    pub status: String,
    pub summary: String,
    pub note: Option<String>,
    pub entries: Vec<UsageEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week_used_percent: Option<u8>,
    /// Unix timestamp, in seconds, for the next reset of the rolling weekly window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week_reset_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSnapshot {
    pub refreshed_at: String,
    pub claude: ProviderUsageSnapshot,
    pub codex: ProviderUsageSnapshot,
    pub antigravity: ProviderUsageSnapshot,
    pub zai: ProviderUsageSnapshot,
}
