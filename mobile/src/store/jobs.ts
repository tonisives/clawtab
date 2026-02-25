import { create } from "zustand";
import type { JobStatus, RemoteJob } from "../types/job";

const IDLE_STATUS: JobStatus = { state: "idle" };

interface JobsState {
  jobs: RemoteJob[];
  statuses: Record<string, JobStatus>;

  setJobs: (jobs: RemoteJob[], statuses: Record<string, JobStatus>) => void;
  updateStatus: (name: string, status: JobStatus) => void;
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: [],
  statuses: {},

  setJobs: (jobs, statuses) => set({ jobs, statuses }),

  updateStatus: (name, status) =>
    set((state) => ({
      statuses: { ...state.statuses, [name]: status },
    })),
}));

export function useJob(name: string): RemoteJob | undefined {
  return useJobsStore((s) => s.jobs.find((j) => j.name === name));
}

export function useJobStatus(name: string): JobStatus {
  return useJobsStore((s) => s.statuses[name] ?? IDLE_STATUS);
}
