export type ProcessProvider = "claude" | "codex" | "opencode" | "antigravity" | "shell";

export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentEffortOption {
  value: AgentEffort;
  label: string;
  color: string;
}

export interface AgentSelection {
  provider: ProcessProvider;
  modelId: string | null;
  effort: AgentEffort | null;
}

/** Effort used when an older job has no explicit effort saved yet. */
export function defaultAgentEffort(
  provider: ProcessProvider | null | undefined,
  _modelId?: string | null,
): AgentEffort | null {
  return provider && provider !== "shell" ? "medium" : null;
}

export const AGENT_EFFORT_OPTIONS: AgentEffortOption[] = [
  { value: "low", label: "Low", color: "#34c759" },
  { value: "medium", label: "Medium", color: "#8bc34a" },
  { value: "high", label: "High", color: "#f2c94c" },
  { value: "xhigh", label: "Extra high", color: "#f2994a" },
  { value: "max", label: "Max", color: "#e67e22" },
];

export interface AgentModelOption {
  provider: ProcessProvider;
  modelId: string | null;
  label: string;
}

/**
 * Older selector versions persisted provider/effort display labels as model
 * IDs. They are not models and must not be offered in model pickers.
 */
export function isSyntheticAgentModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  return /^(?:codex|claude|sol|terra|luna|sonnet|opus|haiku)-(?:low|medium|high|xhigh|max)$/i.test(modelId.trim());
}

/**
 * Models currently exposed by the installed Codex CLI and Claude lineup.
 * Detected and user-added models are merged into this catalog by each client.
 */
export const CURRENT_AGENT_MODEL_OPTIONS: AgentModelOption[] = [
  { provider: "codex", modelId: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
  { provider: "codex", modelId: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
  { provider: "codex", modelId: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
  { provider: "codex", modelId: "gpt-5.5", label: "GPT-5.5" },
  { provider: "codex", modelId: "gpt-5.4", label: "GPT-5.4" },
  { provider: "codex", modelId: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { provider: "codex", modelId: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  { provider: "claude", modelId: "claude-fable-5", label: "Claude Fable 5" },
  { provider: "claude", modelId: "claude-opus-5", label: "Claude Opus 5" },
  { provider: "claude", modelId: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { provider: "claude", modelId: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { provider: "claude", modelId: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

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
