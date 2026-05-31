import { create } from "zustand";
import type { DetectedProcess, JobStatus, RemoteJob } from "../types/job";

const IDLE_STATUS: JobStatus = { state: "idle" };
const STOPPED_PANE_IGNORE_MS = 20000;
const stoppedPaneIgnoreUntil = new Map<string, number>();

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
  upsertDetectedProcess: (process: DetectedProcess) => void;
  removeDetectedProcess: (paneId: string) => void;
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

  setDetectedProcesses: (processes) => set((state) => {
    const now = Date.now();
    for (const [paneId, ignoreUntil] of stoppedPaneIgnoreUntil) {
      if (ignoreUntil <= now) stoppedPaneIgnoreUntil.delete(paneId);
    }
    const visibleProcesses = processes.filter((process) => {
      const ignoreUntil = stoppedPaneIgnoreUntil.get(process.pane_id) ?? 0;
      return ignoreUntil <= now;
    });
    const incomingIds = new Set(visibleProcesses.map((process) => process.pane_id));
    const pending = state.detectedProcesses.filter((process) => {
      if (process._transient_state !== "starting") return false;
      if (incomingIds.has(process.pane_id)) return false;
      const startedAt = process.session_started_at ? Date.parse(process.session_started_at) : NaN;
      return Number.isFinite(startedAt) && now - startedAt < 30000;
    });
    return { detectedProcesses: [...visibleProcesses, ...pending], processesLoaded: true };
  }),

  upsertDetectedProcess: (process) =>
    set((state) => {
      stoppedPaneIgnoreUntil.delete(process.pane_id);
      return {
        detectedProcesses: state.detectedProcesses.some((item) => item.pane_id === process.pane_id)
          ? state.detectedProcesses.map((item) => item.pane_id === process.pane_id ? { ...item, ...process } : item)
          : [...state.detectedProcesses, process],
        processesLoaded: true,
      };
    }),

  removeDetectedProcess: (paneId) =>
    set((state) => {
      stoppedPaneIgnoreUntil.set(paneId, Date.now() + STOPPED_PANE_IGNORE_MS);
      return {
        detectedProcesses: state.detectedProcesses.filter((process) => process.pane_id !== paneId),
        processesLoaded: true,
      };
    }),

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
