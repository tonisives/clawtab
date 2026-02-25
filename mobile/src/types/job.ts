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
