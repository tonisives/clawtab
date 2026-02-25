import type { ClaudeProcess, JobStatus, RemoteJob, RunDetail, RunRecord } from "./job";

// Messages sent by this client to the relay server
export type ClientMessage =
  | { type: "list_jobs"; id: string }
  | { type: "run_job"; id: string; name: string }
  | { type: "pause_job"; id: string; name: string }
  | { type: "resume_job"; id: string; name: string }
  | { type: "stop_job"; id: string; name: string }
  | { type: "send_input"; id: string; name: string; text: string }
  | { type: "subscribe_logs"; id: string; name: string }
  | { type: "unsubscribe_logs"; name: string }
  | { type: "get_run_history"; id: string; name: string; limit: number }
  | { type: "run_agent"; id: string; prompt: string }
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
  | { type: "detect_processes"; id: string }
  | { type: "get_run_detail"; id: string; run_id: string };

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
  | { type: "run_agent_ack"; id: string; success: boolean; job_name?: string }
  | { type: "create_job_ack"; id: string; success: boolean; error?: string }
  | { type: "detected_processes"; id: string; processes: ClaudeProcess[] }
  | { type: "run_detail_response"; id: string; detail?: RunDetail };

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
