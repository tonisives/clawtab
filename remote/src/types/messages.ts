import type { AgentActivity, AgentEffort, JobUpdate } from "@clawtab/shared";
import type { DetectedProcess, ClaudeQuestion, JobStatus, NotificationHistoryItem, RemoteJob, RunDetail, RunRecord } from "./job";

// Messages sent by this client to the relay server
export type ClientMessage =
  | { type: "list_jobs"; id: string }
  | { type: "run_job"; id: string; name: string; params?: Record<string, string> }
  | { type: "pause_job"; id: string; name: string }
  | { type: "resume_job"; id: string; name: string }
  | { type: "stop_job"; id: string; name: string }
  | { type: "send_input"; id: string; name: string; text: string; freetext?: string }
  | { type: "subscribe_logs"; id: string; name: string }
  | { type: "unsubscribe_logs"; name: string }
  | { type: "get_run_history"; id: string; name: string; limit: number }
  | { type: "run_agent"; id: string; prompt: string; work_dir?: string; provider?: string; model?: string; effort?: AgentEffort }
  | {
      type: "create_job";
      id: string;
      name: string;
      job_type: string;
      path?: string;
      prompt?: string;
      cron?: string;
      group?: string;
    }
  | { type: "update_job"; id: string; name: string; update: JobUpdate }
  | { type: "detect_processes"; id: string }
  | { type: "get_settings"; id: string }
  | { type: "get_usage"; id: string }
  | { type: "get_run_detail"; id: string; run_id: string }
  | { type: "get_detected_process_logs"; id: string; tmux_session: string; pane_id: string }
  | { type: "send_detected_process_input"; id: string; pane_id: string; text: string }
  | { type: "stop_detected_process"; id: string; pane_id: string }
  | { type: "register_push_token"; id: string; push_token: string; platform: string }
  | { type: "answer_question"; id: string; question_id: string; pane_id: string; answer: string; freetext?: string }
  | { type: "set_auto_yes_panes"; id: string; pane_ids: string[] }
  | { type: "get_notification_history"; id: string; limit: number }
  | { type: "subscribe_pty"; id: string; pane_id: string; tmux_session: string; cols: number; rows: number }
  | { type: "unsubscribe_pty"; pane_id: string }
  | { type: "pty_input"; pane_id: string; data: string }
  | { type: "tmux_pane_key"; pane_id: string; key: string }
  | { type: "pty_resize"; pane_id: string; cols: number; rows: number }
  | { type: "set_pinned_item"; id: string; key: string; pinned: boolean }
  | { type: "merge_pinned_items"; id: string; items: string[] }
  | { type: "set_pane_display_name"; id: string; pane_id: string; display_name?: string };

// Messages received from the relay (desktop responses forwarded through)
export type DesktopMessage =
  | {
      type: "jobs_list";
      id: string;
      jobs: RemoteJob[];
      statuses: Record<string, JobStatus>;
    }
  | { type: "status_update"; name: string; status: JobStatus }
  | { type: "log_chunk"; name: string; content: string; timestamp: string }
  | {
      type: "jobs_changed";
      jobs: RemoteJob[];
      statuses: Record<string, JobStatus>;
    }
  | { type: "run_history"; id: string; runs: RunRecord[] }
  | { type: "run_job_ack"; id: string; success: boolean; error?: string }
  | { type: "pause_job_ack"; id: string; success: boolean; error?: string }
  | { type: "resume_job_ack"; id: string; success: boolean; error?: string }
  | { type: "stop_job_ack"; id: string; success: boolean; error?: string }
  | { type: "send_input_ack"; id: string; success: boolean }
  | { type: "subscribe_logs_ack"; id: string; success: boolean }
  | {
      type: "run_agent_ack";
      id: string;
      success: boolean;
      job_id?: string;
      pane_id?: string;
      tmux_session?: string;
      work_dir?: string;
      provider?: string;
      error?: string;
    }
  | { type: "create_job_ack"; id: string; success: boolean; error?: string }
  | { type: "update_job_ack"; id: string; success: boolean; error?: string }
  | { type: "detected_processes"; id: string; processes: DetectedProcess[] }
  | { type: "agent_activity"; activity: AgentActivity[] }
  | { type: "settings_response"; id: string; enabled_models: Record<string, string[]>; default_provider: string; default_model?: string }
  | { type: "usage_response"; id: string; usage: UsageSnapshot }
  | { type: "run_detail_response"; id: string; detail?: RunDetail }
  | { type: "detected_process_logs"; id: string; logs: string }
  | { type: "send_detected_process_input_ack"; id: string; success: boolean }
  | { type: "stop_detected_process_ack"; id: string; success: boolean; error?: string }
  | { type: "claude_questions"; questions: ClaudeQuestion[] }
  | { type: "auto_yes_panes"; pane_ids: string[] }
  | { type: "notification_history"; id: string; notifications: NotificationHistoryItem[] }
  | { type: "register_push_token_ack"; id: string; success: boolean }
  | { type: "subscribe_pty_ack"; id: string; success: boolean; error?: string }
  | { type: "pty_output"; pane_id: string; data: string }
  | { type: "pty_exit"; pane_id: string }
  | { type: "pinned_items"; items: string[] }
  | { type: "set_pinned_item_ack"; id: string; success: boolean; error?: string }
  | { type: "merge_pinned_items_ack"; id: string; success: boolean; error?: string }
  | { type: "pane_display_name_changed"; pane_id: string; display_name?: string }
  | { type: "set_pane_display_name_ack"; id: string; success: boolean; error?: string };

// Messages from the relay server itself
export type ServerMessage =
  | {
      type: "welcome";
      connection_id: string;
      server_version: string;
    }
  | { type: "error"; id?: string; code: string; message: string }
  | {
      type: "desktop_status";
      device_id: string;
      device_name: string;
      online: boolean;
    };

export type IncomingMessage = DesktopMessage | ServerMessage;

export interface UsageEntry {
  label: string;
  value: string;
}

export interface ProviderUsageSnapshot {
  provider: string;
  status: string;
  summary: string;
  note?: string | null;
  entries: UsageEntry[];
  week_used_percent?: number | null;
  week_reset_at?: number | null;
}

export interface UsageSnapshot {
  refreshed_at: string;
  claude: ProviderUsageSnapshot;
  codex: ProviderUsageSnapshot;
  antigravity: ProviderUsageSnapshot;
  zai: ProviderUsageSnapshot;
}
