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
  enabledModels: Record<string, string[]> | null;
  defaultProvider: string | null;
  defaultModel: string | null;

  setJobs: (jobs: RemoteJob[], statuses: Record<string, JobStatus>) => void;
  updateStatus: (name: string, status: JobStatus) => void;
  setDetectedProcesses: (processes: DetectedProcess[]) => void;
  hydrateFromCache: (jobs: RemoteJob[], statuses: Record<string, JobStatus>) => void;
  setDesktopSettings: (enabledModels: Record<string, string[]>, defaultProvider: string, defaultModel?: string) => void;
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: [],
  statuses: {},
  detectedProcesses: [],
  loaded: false,
  cachedLoad: false,
  processesLoaded: false,
  enabledModels: null,
  defaultProvider: null,
  defaultModel: null,

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

  setDesktopSettings: (enabledModels, defaultProvider, defaultModel) =>
    set({ enabledModels, defaultProvider, defaultModel: defaultModel ?? null }),
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
