export type JobType = "binary" | "claude" | "folder";

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

export type SecretSource = "keychain" | "gopass";

export interface SecretEntry {
  key: string;
  source: SecretSource;
}

export interface AppSettings {
  default_tmux_session: string;
  default_work_dir: string;
  claude_path: string;
}

export interface ToolInfo {
  name: string;
  available: boolean;
  version: string | null;
  path: string | null;
}

export type JobStatus =
  | { state: "idle" }
  | { state: "running"; run_id: string; started_at: string }
  | { state: "success"; last_run: string }
  | { state: "failed"; last_run: string; exit_code: number }
  | { state: "paused" };
