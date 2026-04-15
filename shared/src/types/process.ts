export type ProcessProvider = "claude" | "codex" | "opencode" | "shell";

export interface AgentModelOption {
  provider: ProcessProvider;
  modelId: string | null;
  label: string;
}

export interface DetectedProcess {
  pane_id: string;
  cwd: string;
  version: string;
  display_name?: string | null;
  provider: ProcessProvider;
  can_fork_session: boolean;
  can_send_skills: boolean;
  can_inject_secrets: boolean;
  tmux_session: string;
  window_name: string;
  matched_group: string | null;
  matched_job: string | null;
  log_lines: string;
  first_query: string | null;
  last_query: string | null;
  session_started_at: string | null;
  token_count?: number | null;
  _transient_state?: "starting" | "stopping";
  /** Timestamp (ms) when log_lines last changed, set client-side */
  _last_log_change?: number;
}

export interface ShellPane {
  pane_id: string;
  cwd: string;
  tmux_session: string;
  window_name: string;
  matched_group?: string | null;
  display_name?: string | null;
}

export interface QuestionOption {
  number: string;
  label: string;
  selected?: boolean;
  col?: number;
}

export interface ClaudeQuestion {
  pane_id: string;
  cwd: string;
  tmux_session: string;
  window_name: string;
  question_id: string;
  context_lines: string;
  options: QuestionOption[];
  input_mode?: "numbered" | "select";
  button_row?: number;
  matched_group?: string | null;
  matched_job?: string | null;
}
