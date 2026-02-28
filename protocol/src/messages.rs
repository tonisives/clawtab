use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::job::{ClaudeProcess, ClaudeQuestion, JobStatus, RemoteJob, RunDetail, RunRecord};

/// Messages sent by mobile/web clients to the relay server.
/// The relay forwards these to the appropriate desktop app.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    ListJobs {
        id: String,
    },
    RunJob {
        id: String,
        name: String,
        #[serde(default)]
        params: HashMap<String, String>,
    },
    PauseJob {
        id: String,
        name: String,
    },
    ResumeJob {
        id: String,
        name: String,
    },
    StopJob {
        id: String,
        name: String,
    },
    SendInput {
        id: String,
        name: String,
        text: String,
    },
    SubscribeLogs {
        id: String,
        name: String,
    },
    UnsubscribeLogs {
        name: String,
    },
    GetRunHistory {
        id: String,
        name: String,
        limit: u32,
    },
    RunAgent {
        id: String,
        prompt: String,
    },
    CreateJob {
        id: String,
        name: String,
        job_type: String,
        #[serde(default)]
        path: String,
        #[serde(default)]
        prompt: String,
        #[serde(default)]
        cron: String,
        #[serde(default)]
        group: String,
    },
    DetectProcesses {
        id: String,
    },
    GetRunDetail {
        id: String,
        run_id: String,
    },
    GetDetectedProcessLogs {
        id: String,
        tmux_session: String,
        pane_id: String,
    },
    SendDetectedProcessInput {
        id: String,
        pane_id: String,
        text: String,
    },
    StopDetectedProcess {
        id: String,
        pane_id: String,
    },
    RegisterPushToken {
        id: String,
        push_token: String,
        platform: String,
    },
    AnswerQuestion {
        id: String,
        question_id: String,
        pane_id: String,
        answer: String,
    },
    /// Tell relay which pane_ids have auto-yes enabled (suppresses push notifications)
    SetAutoYesPanes {
        id: String,
        pane_ids: Vec<String>,
    },
    GetNotificationHistory {
        id: String,
        limit: u32,
    },
}

/// Messages sent by the desktop app to the relay server.
/// These are either responses to client requests (with matching `id`)
/// or proactive state updates (no `id`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DesktopMessage {
    /// Response to list_jobs
    JobsList {
        id: String,
        jobs: Vec<RemoteJob>,
        statuses: HashMap<String, JobStatus>,
    },
    /// Proactive status change
    StatusUpdate {
        name: String,
        status: JobStatus,
    },
    /// Log output for a subscribed job
    LogChunk {
        name: String,
        content: String,
        timestamp: String,
    },
    /// Job config changed (create/edit/delete)
    JobsChanged {
        jobs: Vec<RemoteJob>,
        statuses: HashMap<String, JobStatus>,
    },
    /// Response to get_run_history
    RunHistory {
        id: String,
        runs: Vec<RunRecord>,
    },
    /// Ack for run_job
    RunJobAck {
        id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Ack for pause_job
    PauseJobAck {
        id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Ack for resume_job
    ResumeJobAck {
        id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Ack for stop_job
    StopJobAck {
        id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Ack for send_input
    SendInputAck {
        id: String,
        success: bool,
    },
    /// Ack for subscribe_logs
    SubscribeLogsAck {
        id: String,
        success: bool,
    },
    /// Ack for run_agent
    RunAgentAck {
        id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        job_name: Option<String>,
    },
    /// Ack for create_job
    CreateJobAck {
        id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Response to detect_processes
    DetectedProcesses {
        id: String,
        processes: Vec<ClaudeProcess>,
    },
    /// Response to get_run_detail
    RunDetailResponse {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<RunDetail>,
    },
    /// Response to get_detected_process_logs
    DetectedProcessLogs {
        id: String,
        logs: String,
    },
    /// Ack for send_detected_process_input
    SendDetectedProcessInputAck {
        id: String,
        success: bool,
    },
    /// Ack for stop_detected_process
    StopDetectedProcessAck {
        id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Desktop proactively pushes when Claude questions change
    ClaudeQuestions {
        questions: Vec<ClaudeQuestion>,
    },
    /// Desktop pushes job status events for APNs push notifications
    JobNotification {
        name: String,
        event: String,
        run_id: String,
    },
}

/// Messages sent by the relay server to connected clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Welcome {
        connection_id: String,
        server_version: String,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        code: String,
        message: String,
    },
    DesktopStatus {
        device_id: String,
        device_name: String,
        online: bool,
    },
}

/// Error codes used in ServerMessage::Error
pub mod error_codes {
    pub const DESKTOP_OFFLINE: &str = "DESKTOP_OFFLINE";
    pub const JOB_NOT_FOUND: &str = "JOB_NOT_FOUND";
    pub const UNAUTHORIZED: &str = "UNAUTHORIZED";
    pub const SUBSCRIPTION_EXPIRED: &str = "SUBSCRIPTION_EXPIRED";
    pub const RATE_LIMITED: &str = "RATE_LIMITED";
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
    pub const INVALID_MESSAGE: &str = "INVALID_MESSAGE";
}
