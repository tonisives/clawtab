import { create } from "zustand";
import type { AgentActivity, ProcessAgentState } from "@clawtab/shared";
import type { DetectedProcess, JobStatus, RemoteJob } from "../types/job";

const IDLE_STATUS: JobStatus = { state: "idle" };
const STOPPED_PANE_IGNORE_MS = 20000;
const stoppedPaneIgnoreUntil = new Map<string, number>();

type StoredAgentActivity = AgentActivity & {
  last_activity: number;
};

const agentStateFor = (activity: AgentActivity): ProcessAgentState => {
  if (activity.asking) return "asking";
  if (activity.working) return "working";
  return "finished";
};

const parsedTimestamp = (value: string | null | undefined): number => {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
};

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
  agentActivity: Record<string, StoredAgentActivity>;
  questionPaneIds: Set<string>;

  setJobs: (jobs: RemoteJob[], statuses: Record<string, JobStatus>) => void;
  updateStatus: (name: string, status: JobStatus) => void;
  setDetectedProcesses: (processes: DetectedProcess[]) => void;
  setAgentActivity: (activity: AgentActivity[]) => void;
  setQuestionPanes: (paneIds: string[]) => void;
  markProcessActivity: (paneId: string) => void;
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
  agentActivity: {},
  questionPaneIds: new Set(),

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
    const incomingProcesses = processes.filter((process) => {
      const ignoreUntil = stoppedPaneIgnoreUntil.get(process.pane_id) ?? 0;
      return ignoreUntil <= now;
    });
    const previousByPaneId = new Map(
      state.detectedProcesses.map((process) => [process.pane_id, process]),
    );
    const visibleProcesses = incomingProcesses.map((process) => {
      const previous = previousByPaneId.get(process.pane_id);
      const activity = state.agentActivity[process.pane_id];
      const outputChanged = previous != null && (
        previous.log_lines !== process.log_lines
        || previous.last_query !== process.last_query
        || previous.token_count !== process.token_count
      );
      const lastLogChange = outputChanged ? now : previous?._last_log_change ?? now;
      const lastActivity = Math.max(
        outputChanged ? now : 0,
        previous?._last_activity ?? 0,
        activity?.last_activity ?? 0,
        parsedTimestamp(process.session_started_at),
      );
      return {
        ...process,
        _last_log_change: lastLogChange,
        _last_activity: lastActivity,
        _agent_state: state.questionPaneIds.has(process.pane_id)
          ? "asking"
          : activity
            ? agentStateFor(activity)
            : undefined,
      };
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

  setAgentActivity: (activity) => set((state) => {
    const now = Date.now();
    const nextActivity: Record<string, StoredAgentActivity> = {};
    for (const item of activity) {
      const previous = state.agentActivity[item.pane_id];
      const changed = !previous
        || previous.working !== item.working
        || previous.asking !== item.asking;
      nextActivity[item.pane_id] = {
        ...item,
        last_activity: changed ? now : previous.last_activity,
      };
    }
    return {
      agentActivity: nextActivity,
      detectedProcesses: state.detectedProcesses.map((process) => {
        const item = nextActivity[process.pane_id];
        if (!item) {
          return {
            ...process,
            _agent_state: state.questionPaneIds.has(process.pane_id) ? "asking" : undefined,
          };
        }
        return {
          ...process,
          _agent_state: state.questionPaneIds.has(process.pane_id)
            ? "asking"
            : agentStateFor(item),
          _last_activity: Math.max(process._last_activity ?? 0, item.last_activity),
        };
      }),
    };
  }),

  setQuestionPanes: (paneIds) => set((state) => {
    const now = Date.now();
    const nextQuestionPaneIds = new Set(paneIds);
    return {
      questionPaneIds: nextQuestionPaneIds,
      detectedProcesses: state.detectedProcesses.map((process) => {
        const isAsking = nextQuestionPaneIds.has(process.pane_id);
        const wasAsking = state.questionPaneIds.has(process.pane_id);
        if (!isAsking && !wasAsking) return process;
        const activity = state.agentActivity[process.pane_id];
        return {
          ...process,
          _agent_state: isAsking
            ? "asking"
            : activity
              ? agentStateFor(activity)
              : undefined,
          _last_activity: isAsking && !wasAsking
            ? now
            : process._last_activity,
        };
      }),
    };
  }),

  markProcessActivity: (paneId) => set((state) => {
    const now = Date.now();
    const currentActivity = state.agentActivity[paneId];
    const questionPaneIds = new Set(state.questionPaneIds);
    questionPaneIds.delete(paneId);
    return {
      questionPaneIds,
      agentActivity: currentActivity
        ? {
            ...state.agentActivity,
            [paneId]: {
              ...currentActivity,
              working: true,
              asking: false,
              last_activity: now,
            },
          }
        : state.agentActivity,
      detectedProcesses: state.detectedProcesses.map((process) => (
        process.pane_id === paneId
          ? {
              ...process,
              _agent_state: currentActivity ? "working" : undefined,
              _last_log_change: now,
              _last_activity: now,
            }
          : process
      )),
    };
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
