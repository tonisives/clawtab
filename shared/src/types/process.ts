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
