import { create } from "zustand";
import type { ClaudeProcess, JobStatus, RemoteJob } from "../types/job";

const IDLE_STATUS: JobStatus = { state: "idle" };

interface JobsState {
  jobs: RemoteJob[];
  statuses: Record<string, JobStatus>;
  detectedProcesses: ClaudeProcess[];
  loaded: boolean;

  setJobs: (jobs: RemoteJob[], statuses: Record<string, JobStatus>) => void;
  updateStatus: (name: string, status: JobStatus) => void;
  setDetectedProcesses: (processes: ClaudeProcess[]) => void;
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: [],
  statuses: {},
  detectedProcesses: [],
  loaded: false,

  setJobs: (jobs, statuses) => set({ jobs, statuses, loaded: true }),

  updateStatus: (name, status) =>
    set((state) => ({
      statuses: { ...state.statuses, [name]: status },
    })),

  setDetectedProcesses: (processes) => set({ detectedProcesses: processes }),
}));

export function useJob(name: string): RemoteJob | undefined {
  return useJobsStore((s) => s.jobs.find((j) => j.name === name));
}

export function useJobStatus(name: string): JobStatus {
  return useJobsStore((s) => s.statuses[name] ?? IDLE_STATUS);
}
