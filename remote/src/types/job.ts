export type {
  RemoteJob,
  JobStatus,
  RunRecord,
  RunDetail,
} from "@clawtab/shared";

export type {
  ClaudeProcess,
  QuestionOption,
  ClaudeQuestion,
} from "@clawtab/shared";

// Remote-only type
export interface NotificationHistoryItem {
  question_id: string;
  pane_id: string;
  cwd: string;
  context_lines: string;
  options: { number: string; label: string }[];
  answered: boolean;
  answered_with?: string | null;
  created_at: string;
}
