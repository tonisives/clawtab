//! Task labels come from the agent already doing the work. Looking them up never
//! starts a model, reads a transcript, or resolves another process snapshot.
use std::collections::BTreeMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::agent_session::ProcessProvider;
use crate::config::settings::AppSettings;

const MAX_TITLES: usize = 256;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TaskTitles(BTreeMap<String, TaskTitle>);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskTitle {
    title: String,
    updated_at: u64,
}

impl TaskTitles {
    pub fn get(&self, provider: Option<ProcessProvider>, session_id: Option<&str>) -> Option<&str> {
        self.0
            .get(&format!("{}:{}", provider?.as_str(), session_id?))
            .map(|entry| entry.title.as_str())
    }

    fn update(
        &mut self,
        provider: ProcessProvider,
        session_id: &str,
        title: &str,
        now: u64,
    ) -> Result<bool, String> {
        if !matches!(provider, ProcessProvider::Codex | ProcessProvider::Claude)
            || session_id.is_empty()
            || session_id.len() > 128
            || !session_id
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || b"-_".contains(&ch))
        {
            return Err("Invalid task-title conversation identity".into());
        }
        let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
        if title.is_empty() || title.chars().count() > 100 || title.chars().any(char::is_control) {
            return Err("Task title must contain 1–100 characters".into());
        }
        if self.get(Some(provider), Some(session_id)) == Some(title.as_str()) {
            return Ok(false);
        }
        self.0.insert(
            format!("{}:{session_id}", provider.as_str()),
            TaskTitle {
                title,
                updated_at: now,
            },
        );
        while self.0.len() > MAX_TITLES {
            let oldest = self
                .0
                .iter()
                .min_by_key(|(_, entry)| entry.updated_at)
                .map(|(key, _)| key.clone())
                .unwrap();
            self.0.remove(&oldest);
        }
        Ok(true)
    }
}

pub fn save(
    settings: &Arc<Mutex<AppSettings>>,
    provider: ProcessProvider,
    session_id: &str,
    title: &str,
) -> Result<(), String> {
    let mut settings = settings.lock();
    let mut titles = settings.session_task_titles.clone();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if titles.update(provider, session_id, title, now)? {
        let previous = std::mem::replace(&mut settings.session_task_titles, titles);
        if let Err(error) = settings.save() {
            settings.session_task_titles = previous;
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_titles_follow_conversations_and_keep_providers_separate() {
        let mut titles = TaskTitles::default();
        assert!(titles
            .update(
                ProcessProvider::Codex,
                "conversation",
                "Record browser demos",
                1
            )
            .unwrap());
        assert_eq!(
            titles.get(Some(ProcessProvider::Codex), Some("conversation")),
            Some("Record browser demos")
        );
        assert_eq!(
            titles.get(Some(ProcessProvider::Claude), Some("conversation")),
            None
        );
        assert_eq!(
            titles.get(Some(ProcessProvider::Codex), Some("other-conversation")),
            None
        );
        assert!(!titles
            .update(
                ProcessProvider::Codex,
                "conversation",
                "Record browser demos",
                2
            )
            .unwrap());
        assert!(titles
            .update(
                ProcessProvider::Codex,
                "conversation",
                "Fix pane routing",
                3
            )
            .unwrap());
        let restored: TaskTitles =
            serde_json::from_str(&serde_json::to_string(&titles).unwrap()).unwrap();
        assert_eq!(
            restored.get(Some(ProcessProvider::Codex), Some("conversation")),
            Some("Fix pane routing")
        );
    }

    #[test]
    fn task_title_storage_is_bounded() {
        let mut titles = TaskTitles::default();
        for i in 0..=MAX_TITLES {
            titles
                .update(
                    ProcessProvider::Codex,
                    &format!("session-{i}"),
                    "Task",
                    i as u64,
                )
                .unwrap();
        }
        assert_eq!(titles.0.len(), MAX_TITLES);
        assert_eq!(
            titles.get(Some(ProcessProvider::Codex), Some("session-0")),
            None
        );
    }
}
