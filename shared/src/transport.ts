import type { RemoteJob, JobStatus, RunRecord, RunDetail } from "./types/job";
import type { ClaudeProcess } from "./types/process";

export interface Transport {
  listJobs(): Promise<{ jobs: RemoteJob[]; statuses: Record<string, JobStatus> }>;
  getStatuses(): Promise<Record<string, JobStatus>>;
  runJob(name: string, params?: Record<string, string>): Promise<void>;
  stopJob(name: string): Promise<void>;
  pauseJob(name: string): Promise<void>;
  resumeJob(name: string): Promise<void>;
  toggleJob(name: string): Promise<void>;
  deleteJob(name: string): Promise<void>;
  getRunHistory(name: string): Promise<RunRecord[]>;
  getRunDetail(runId: string): Promise<RunDetail | null>;
  detectProcesses(): Promise<ClaudeProcess[]>;
  sendInput(name: string, text: string): Promise<void>;
  subscribeLogs(name: string, onChunk: (content: string) => void): () => void;
  runAgent(prompt: string): Promise<void>;
  // Desktop-only (optional)
  focusJobWindow?(name: string): Promise<void>;
  saveJob?(job: RemoteJob): Promise<void>;
  restartJob?(name: string, params?: Record<string, string>): Promise<void>;
}
