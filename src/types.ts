export type JobType = "binary" | "claude" | "folder";
export type TelegramLogMode = "off" | "on_prompt" | "always";

export interface TelegramNotify {
  start: boolean;
  working: boolean;
  logs: boolean;
  finish: boolean;
}

export interface Job {
  name: string;
  job_type: JobType;
  enabled: boolean;
  path: string;
  args: string[];
  cron: string;
  secret_keys: string[];
  env: Record<string, string>;
  work_dir: string | null;
  tmux_session: string | null;
  aerospace_workspace: string | null;
  folder_path: string | null;
  job_name: string | null;
  telegram_chat_id: number | null;
  telegram_log_mode: TelegramLogMode;
  telegram_notify: TelegramNotify;
  group: string;
  slug: string;
  skill_paths: string[];
}

export interface AerospaceWorkspace {
  name: string;
}

export interface RunRecord {
  id: string;
  job_name: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  trigger: string;
  stdout: string;
  stderr: string;
}

export type SecretSource = "keychain";

export interface SecretEntry {
  key: string;
  source: SecretSource;
}

export interface TelegramConfig {
  bot_token: string;
  chat_ids: number[];
  chat_names: Record<string, string>;
  notify_on_success: boolean;
  notify_on_failure: boolean;
  agent_enabled: boolean;
}

export interface AppSettings {
  default_tmux_session: string;
  default_work_dir: string;
  claude_path: string;
  preferred_editor: string;
  preferred_terminal: string;
  setup_completed: boolean;
  telegram: TelegramConfig | null;
  secrets_backend: string;
  preferred_browser: string;
  auto_update_enabled: boolean;
  tool_paths: Record<string, string>;
  group_order: string[];
}

export interface ToolInfo {
  name: string;
  available: boolean;
  version: string | null;
  path: string | null;
  category: string;
  required: boolean;
  group: string | null;
  brew_formula: string | null;
}

export type JobStatus =
  | { state: "idle" }
  | { state: "running"; run_id: string; started_at: string; pane_id?: string; tmux_session?: string }
  | { state: "success"; last_run: string }
  | { state: "failed"; last_run: string; exit_code: number }
  | { state: "paused" };
