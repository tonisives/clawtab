import type { RemoteJob, JobStatus, RunRecord, RunDetail } from "./types/job";
import type { DetectedProcess, ProcessProvider, ShellPane } from "./types/process";

export interface Transport {
  listJobs(): Promise<{ jobs: RemoteJob[]; statuses: Record<string, JobStatus> }>;
  getStatuses(): Promise<Record<string, JobStatus>>;
  getCachedJobs?(): Promise<{ jobs: RemoteJob[]; statuses: Record<string, JobStatus> } | null>;
  cacheJobs?(jobs: RemoteJob[], statuses: Record<string, JobStatus>): Promise<void>;
  runJob(name: string, params?: Record<string, string>): Promise<{ pane_id: string; tmux_session: string } | null>;
  stopJob(name: string): Promise<void>;
  pauseJob(name: string): Promise<void>;
  resumeJob(name: string): Promise<void>;
  toggleJob(name: string): Promise<void>;
  deleteJob(name: string): Promise<void>;
  getRunHistory(name: string): Promise<RunRecord[]>;
  getRunDetail(runId: string): Promise<RunDetail | null>;
  detectProcesses(): Promise<DetectedProcess[]>;
  sendInput(name: string, text: string, freetext?: string): Promise<void>;
  subscribeLogs(name: string, onChunk: (content: string) => void): () => void;
  runAgent(prompt: string, workDir?: string, provider?: ProcessProvider, model?: string): Promise<{ pane_id: string; tmux_session: string } | null>;
  listAgentProviders?(): Promise<ProcessProvider[]>;
  // Desktop-only (optional)
  focusJobWindow?(name: string): Promise<void>;
  saveJob?(job: RemoteJob): Promise<void>;
  restartJob?(name: string, params?: Record<string, string>): Promise<void>;
  sigintJob?(name: string): Promise<void>;
  getExistingPaneInfo?(paneId: string): Promise<ShellPane | null>;
}
