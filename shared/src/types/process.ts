export interface ClaudeProcess {
  pane_id: string;
  cwd: string;
  version: string;
  process_type?: "claude" | "codex";
  tmux_session: string;
  window_name: string;
  matched_group: string | null;
  matched_job: string | null;
  log_lines: string;
  first_query: string | null;
  last_query: string | null;
  session_started_at: string | null;
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
}

export interface QuestionOption {
  number: string;
  label: string;
}

export interface ClaudeQuestion {
  pane_id: string;
  cwd: string;
  tmux_session: string;
  window_name: string;
  question_id: string;
  context_lines: string;
  options: QuestionOption[];
  matched_group?: string | null;
  matched_job?: string | null;
}
