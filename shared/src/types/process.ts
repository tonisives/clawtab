export type ProcessProvider = "claude" | "codex" | "opencode" | "antigravity" | "shell";

export interface AgentModelOption {
  provider: ProcessProvider;
  modelId: string | null;
  label: string;
}

export type AgentActivity = {
  pane_id: string;
  working: boolean;
  asking: boolean;
};

export type ProcessAgentState = "working" | "asking" | "finished";

export interface DetectedProcess {
  pane_id: string;
  cwd: string;
  version: string;
  display_name?: string | null;
  pane_title?: string | null;
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
  /** Authoritative agent state received from the daemon. */
  _agent_state?: ProcessAgentState;
  /** Timestamp (ms) of the latest observed user or agent activity. */
  _last_activity?: number;
}

export interface ShellPane {
  pane_id: string;
  cwd: string;
  tmux_session: string;
  window_name: string;
  pane_title?: string | null;
  matched_group?: string | null;
  display_name?: string | null;
  // Client-side sticky workspace association. Set at shell creation to the
  // active workspace id so cross-cwd use doesn't move the pane out.
  workspace_id?: string;
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
