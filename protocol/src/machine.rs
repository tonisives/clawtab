//! Versioned machine control. Payloads reuse the existing job/terminal protocol.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MACHINE_PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineCommand {
    pub version: u32,
    pub machine_id: String,
    pub request_id: String,
    pub message: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum HostRequest {
    Info,
    JournalContext {
        query: JournalQuery,
    },
    DeleteJob {
        name: String,
    },
    ListDirectory {
        path: Option<String>,
    },
    Repository {
        path: String,
    },
    CloneRepository {
        operation_id: String,
        url: String,
        path: String,
    },
    CreateWorktree {
        operation_id: String,
        path: String,
        branch: String,
        base: String,
    },
    RemoveWorktree {
        operation_id: String,
        path: String,
    },
    Operation {
        operation_id: String,
    },
    SetModels {
        models: std::collections::HashMap<String, Vec<String>>,
    },
    TransferPrepare {
        operation_id: String,
        path: String,
        files: Vec<String>,
    },
    TransferRead {
        operation_id: String,
        offset: u64,
    },
    TransferBegin {
        operation_id: String,
        path: String,
        size: u64,
        sha256: String,
    },
    TransferWrite {
        operation_id: String,
        offset: u64,
        data: String,
    },
    TransferFinish {
        operation_id: String,
    },
    TransferCancel {
        operation_id: String,
    },
}

/// Read-only personal context. Unknown fields cannot select another local API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JournalQuery {
    pub topic: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default = "journal_days")]
    pub days: u32,
    #[serde(default)]
    pub exclude_ids: Vec<String>,
}
fn journal_days() -> u32 {
    5
}
impl JournalQuery {
    pub fn validate(&self) -> Result<(), String> {
        if self.topic.trim().is_empty()
            || self.topic.len() > 12000
            || !(1..=30).contains(&self.days)
            || self.exclude_ids.len() > 100
        {
            return Err("Journal query requires a topic (1–12000 bytes), days (1–30), and at most 100 exclusions".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod journal_tests {
    use super::*;
    #[test]
    fn refuses_other_local_actions_and_unbounded_queries() {
        let query = serde_json::json!({"topic":"Mac apps","days":5,"exclude_ids":[]});
        assert!(serde_json::from_value::<JournalQuery>(query.clone())
            .is_ok_and(|q| q.validate().is_ok()));
        let mut injection = query.clone();
        injection["action"] = serde_json::json!("read_file");
        assert!(serde_json::from_value::<JournalQuery>(injection).is_err());
        let mut unbounded = query;
        unbounded["days"] = serde_json::json!(365);
        assert!(
            serde_json::from_value::<JournalQuery>(unbounded).is_ok_and(|q| q.validate().is_err())
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostCommand {
    pub r#type: String,
    pub id: String,
    pub request: HostRequest,
}
