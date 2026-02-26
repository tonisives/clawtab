export interface RemoteJob {
  name: string;
  job_type: string;
  enabled: boolean;
  cron: string;
  group: string;
  slug: string;
  work_dir?: string;
  path?: string;
}

export type JobStatus =
  | { state: "idle" }
  | { state: "running"; run_id: string; started_at: string }
  | { state: "success"; last_run: string }
  | { state: "failed"; last_run: string; exit_code: number }
  | { state: "paused" };

export interface RunRecord {
  id: string;
  job_name: string;
  started_at: string;
  finished_at?: string;
  exit_code?: number;
  trigger: string;
}

export interface RunDetail {
  id: string;
  job_name: string;
  started_at: string;
  finished_at?: string;
  exit_code?: number;
  trigger: string;
  stdout: string;
  stderr: string;
}

export interface ClaudeProcess {
  pane_id: string;
  cwd: string;
  version: string;
  tmux_session: string;
  window_name: string;
  matched_group: string | null;
  matched_job: string | null;
  log_lines: string;
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

export interface NotificationHistoryItem {
  question_id: string;
  pane_id: string;
  cwd: string;
  context_lines: string;
  options: QuestionOption[];
  answered: boolean;
  answered_with?: string | null;
  created_at: string;
}
