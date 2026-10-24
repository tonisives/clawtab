//! Durable terminals owned by a launcher process, independent of the daemon.
mod cli;
mod client;
mod owner;
mod screen;
mod store;

pub use cli::run_cli;
pub(crate) use client::launch_preapproved;
pub use client::{connect, launch, list, request, Client};
pub use store::{directory, read_info};

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u32 = 1;
pub const PREFIX: &str = "managed:";
pub const LEASE_SECONDS: u64 = 30;

pub fn is_managed(id: &str) -> bool {
    id.strip_prefix(PREFIX)
        .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok())
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

impl Size {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.clamp(2, 500),
            rows: rows.clamp(1, 300),
        }
    }
}

impl Default for Size {
    fn default() -> Self {
        Self::new(80, 24)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub size: Size,
    #[serde(default)]
    pub close_with_terminal: bool,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Running,
    Exited,
    Interrupted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub execution_id: String,
    pub protocol_version: u32,
    pub launcher_version: String,
    pub owner_pid: u32,
    pub child_pid: u32,
    pub started_at: u64,
    pub launch: Launch,
    pub status: Status,
    pub exit_code: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Control {
    pub epoch: u64,
    pub holder: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct InputModes {
    pub app_cursor: bool,
    pub bracketed_paste: bool,
    pub mouse: bool,
    pub mouse_motion: bool,
    pub mouse_drag: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub revision: u64,
    pub size: Size,
    pub ansi: String,
    pub text: String,
    pub cursor_row: u16,
    pub input_modes: InputModes,
    pub output_revision: u64,
    pub control: Control,
    pub status: Status,
    pub local_attached: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Hello {
        version: u32,
    },
    Info,
    Watch,
    Snapshot {
        after: Option<u64>,
    },
    Capture {
        history: bool,
        ansi: bool,
        lines: u32,
    },
    Attach {
        viewer: String,
        size: Size,
        origin: bool,
    },
    Detach,
    LocalInput {
        data: Vec<u8>,
    },
    LocalResize {
        size: Size,
    },
    TakeControl {
        holder: String,
        size: Size,
    },
    RenewControl {
        holder: String,
        epoch: u64,
    },
    ReleaseControl {
        holder: String,
        epoch: u64,
    },
    RemoteInput {
        holder: String,
        epoch: u64,
        data: Vec<u8>,
    },
    RemoteResize {
        holder: String,
        epoch: u64,
        size: Size,
    },
    AutomationInput {
        data: Vec<u8>,
    },
    Metadata {
        values: BTreeMap<String, String>,
        conversation_id: Option<String>,
    },
    Stop,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Ok,
    Info { session: SessionInfo },
    Snapshot { snapshot: Snapshot },
    Unchanged,
    Capture { content: String },
    Control { control: Control },
    Reclaimed,
    Error { message: String },
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_secs())
        .unwrap_or_default()
}
