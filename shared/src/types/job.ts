import type { ProcessProvider } from "./process";

export type JobType = "binary" | "claude" | "job";

export type JobSortMode = "name" | "recent" | "added";

export interface RemoteJob {
  name: string;
  job_type: string;
  enabled: boolean;
  cron: string;
  group: string;
  slug: string;
  work_dir?: string;
  path?: string;
  folder_path?: string;
  params?: string[];
  agent_provider?: ProcessProvider | null;
  added_at?: string;
}

export type TelegramLogMode = "off" | "on_prompt" | "always";

export interface TelegramNotify {
  start: boolean;
  working: boolean;
  logs: boolean;
  finish: boolean;
}

export interface DesktopJob extends RemoteJob {
  args: string[];
  secret_keys: string[];
  env: Record<string, string>;
  tmux_session: string | null;
  aerospace_workspace: string | null;
  folder_path: string | undefined;
  job_name: string | null;
  telegram_chat_id: number | null;
  telegram_log_mode: TelegramLogMode;
  telegram_notify: TelegramNotify;
  skill_paths: string[];
  agent_provider?: ProcessProvider | null;
}

export type JobStatus =
  | { state: "idle" }
  | { state: "running"; run_id: string; started_at: string; pane_id?: string; tmux_session?: string }
  | { state: "success"; last_run: string }
  | { state: "failed"; last_run: string; exit_code: number }
  | { state: "paused" };

export interface RunRecord {
  id: string;
  job_name: string;
  started_at: string;
  finished_at?: string | null;
  exit_code?: number | null;
  trigger: string;
  stdout?: string;
  stderr?: string;
}

export interface RunDetail {
  id: string;
  job_name: string;
  started_at: string;
  finished_at?: string | null;
  exit_code?: number | null;
  trigger: string;
  stdout: string;
  stderr: string;
}
