import { create } from "zustand";
import type { DetectedProcess, JobStatus, RemoteJob } from "../types/job";

const IDLE_STATUS: JobStatus = { state: "idle" };

interface JobsState {
  jobs: RemoteJob[];
  statuses: Record<string, JobStatus>;
  detectedProcesses: DetectedProcess[];
  loaded: boolean;
  cachedLoad: boolean;
  processesLoaded: boolean;

  setJobs: (jobs: RemoteJob[], statuses: Record<string, JobStatus>) => void;
  updateStatus: (name: string, status: JobStatus) => void;
  setDetectedProcesses: (processes: DetectedProcess[]) => void;
  hydrateFromCache: (jobs: RemoteJob[], statuses: Record<string, JobStatus>) => void;
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: [],
  statuses: {},
  detectedProcesses: [],
  loaded: false,
  cachedLoad: false,
  processesLoaded: false,

  setJobs: (jobs, statuses) => set({ jobs, statuses, loaded: true, cachedLoad: false }),

  updateStatus: (name, status) =>
    set((state) => ({
      statuses: { ...state.statuses, [name]: status },
    })),

  setDetectedProcesses: (processes) => set({ detectedProcesses: processes, processesLoaded: true }),

  hydrateFromCache: (jobs, statuses) =>
    set((state) => {
      if (state.loaded) return state;
      return { jobs, statuses, cachedLoad: true };
    }),
}));

export function useJob(nameOrSlug: string): RemoteJob | undefined {
  return useJobsStore((s) => s.jobs.find((j) => j.name === nameOrSlug || j.slug === nameOrSlug));
}

export function useJobStatus(nameOrSlug: string): JobStatus {
  // Statuses are keyed by slug; find the job to get its slug
  return useJobsStore((s) => {
    const job = s.jobs.find((j) => j.name === nameOrSlug || j.slug === nameOrSlug);
    return s.statuses[job?.slug ?? nameOrSlug] ?? IDLE_STATUS;
  });
}
