import type { ProcessProvider } from "@clawtab/shared";

export type JobType = "binary" | "claude" | "job";
export type TelegramLogMode = "off" | "on_prompt" | "always";
export type NotifyTarget = "none" | "telegram" | "app";

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
  job_id: string | null;
  telegram_chat_id: number | null;
  telegram_log_mode: TelegramLogMode;
  telegram_notify: TelegramNotify;
  notify_target: NotifyTarget;
  group: string;
  slug: string;
  skill_paths: string[];
  params: string[];
  kill_on_end: boolean;
  auto_yes: boolean;
  agent_provider?: ProcessProvider | null;
  agent_model?: string | null;
  added_at?: string;
}

export interface AerospaceWorkspace {
  name: string;
}

export interface RunRecord {
  id: string;
  job_id: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  trigger: string;
  stdout: string;
  stderr: string;
}

export interface ExistingPaneInfo {
  pane_id: string;
  cwd: string;
  tmux_session: string;
  window_name: string;
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

export interface RelaySettings {
  enabled: boolean;
  server_url: string;
  device_token: string;
  device_id: string;
  device_name: string;
}

export interface DetectedProcessOverride {
  display_name?: string | null;
  first_query?: string | null;
  last_query?: string | null;
}

export interface ShortcutSettings {
  prefix_key: string;
  next_sidebar_item: string;
  previous_sidebar_item: string;
  toggle_sidebar: string;
  rename_active_pane: string;
  focus_agent_input: string;
  zoom_active_pane: string;
  split_pane_vertical: string;
  split_pane_horizontal: string;
  kill_pane: string;
  move_pane_left: string;
  move_pane_down: string;
  move_pane_up: string;
  move_pane_right: string;
}

export interface AppSettings {
  default_tmux_session: string;
  default_work_dir: string;
  default_provider: ProcessProvider;
  default_model: string | null;
  enabled_models: Record<string, string[]>;
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
  job_order: Record<string, string[]>;
  hidden_groups: string[];
  relay: RelaySettings | null;
  show_in_dock: boolean;
  show_tray_icon: boolean;
  hide_titlebar: boolean;
  process_overrides: Record<string, DetectedProcessOverride>;
  shortcuts: ShortcutSettings;
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

export interface UsageEntry {
  label: string;
  value: string;
}

export interface ProviderUsageSnapshot {
  provider: string;
  status: "available" | "partial" | "unavailable" | string;
  summary: string;
  note: string | null;
  entries: UsageEntry[];
}

export interface UsageSnapshot {
  refreshed_at: string;
  claude: ProviderUsageSnapshot;
  codex: ProviderUsageSnapshot;
  zai: ProviderUsageSnapshot;
}

export interface DetectedProcess {
  pane_id: string;
  cwd: string;
  version: string;
  provider: "claude" | "codex" | "opencode";
  can_fork_session: boolean;
  can_send_skills: boolean;
  can_inject_secrets: boolean;
  tmux_session: string;
  window_name: string;
  matched_group: string | null;
  matched_job: string | null;
  log_lines: string;
}

export type JobStatus =
  | { state: "idle" }
  | { state: "running"; run_id: string; started_at: string; pane_id?: string; tmux_session?: string }
  | { state: "success"; last_run: string }
  | { state: "failed"; last_run: string; exit_code: number }
  | { state: "paused" };
