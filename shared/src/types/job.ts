import type { AgentEffort, ProcessProvider } from "./process";

export type JobType = "binary" | "claude" | "job";

export type JobSortMode = "name" | "activity" | "recent" | "added";

export type LatestSortMode = "message" | "activity" | "started";

export type JobListMode = "tabs" | "latest" | "jobs";

export type CalendarRepeatUnit = "week";

export type CalendarRepeat = {
  every: number;
  unit: CalendarRepeatUnit;
};

export type CalendarSchedule = {
  start: string;
  repeat: CalendarRepeat;
};

export interface JobParam {
  name: string;
  value?: string | null;
}

export interface RemoteJob {
  name: string;
  job_type: string;
  enabled: boolean;
  cron: string;
  schedule?: CalendarSchedule | null;
  group: string;
  slug: string;
  work_dir?: string;
  tmux_session?: string | null;
  aerospace_workspace?: string | null;
  notify_target?: "none" | "app" | "telegram" | string | null;
  kill_on_end?: boolean;
  auto_yes?: boolean;
  max_history?: number;
  path?: string;
  folder_path?: string;
  params?: JobParam[];
  agent_provider?: ProcessProvider | null;
  agent_model?: string | null;
  agent_effort?: AgentEffort | null;
  added_at?: string;
}

/** Fields that can be changed directly from the job detail view. */
export interface JobUpdate {
  enabled?: boolean;
  cron?: string;
  schedule?: CalendarSchedule | null;
  group?: string;
  work_dir?: string | null;
  tmux_session?: string | null;
  aerospace_workspace?: string | null;
  notify_target?: "none" | "app" | "telegram" | string | null;
  telegram_chat_id?: number | null;
  telegram_notify?: TelegramNotify;
  kill_on_end?: boolean;
  auto_yes?: boolean;
  max_history?: number;
  agent_provider?: ProcessProvider | null;
  agent_model?: string | null;
  agent_effort?: AgentEffort | null;
  secret_keys?: string[];
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
  job_id: string | null;
  telegram_chat_id: number | null;
  telegram_log_mode: TelegramLogMode;
  telegram_notify: TelegramNotify;
  skill_paths: string[];
  agent_provider?: ProcessProvider | null;
  agent_model?: string | null;
  agent_effort?: AgentEffort | null;
}

export type JobStatus =
  | { state: "idle" }
  | { state: "running"; run_id: string; started_at: string; pane_id?: string; tmux_session?: string }
  | { state: "success"; last_run: string }
  | { state: "failed"; last_run: string; exit_code: number }
  | { state: "paused" };

export interface RunRecord {
  id: string;
  job_id: string;
  started_at: string;
  finished_at?: string | null;
  exit_code?: number | null;
  trigger: string;
  stdout?: string;
  stderr?: string;
  pane_id?: string | null;
  log_path?: string | null;
}

export interface RunDetail {
  id: string;
  job_id: string;
  started_at: string;
  finished_at?: string | null;
  exit_code?: number | null;
  trigger: string;
  stdout: string;
  stderr: string;
  pane_id?: string | null;
  log_path?: string | null;
}
