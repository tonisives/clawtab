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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostCommand {
    pub r#type: String,
    pub id: String,
    pub request: HostRequest,
}
