import { create } from "zustand";
import type { RunRecord } from "../types/job";

interface RunsState {
  runs: Record<string, RunRecord[]>;
  setRuns: (jobName: string, runs: RunRecord[]) => void;
}

export const useRunsStore = create<RunsState>((set) => ({
  runs: {},
  setRuns: (jobName, runs) =>
    set((state) => ({
      runs: { ...state.runs, [jobName]: runs },
    })),
}));

export function useRuns(jobName: string): RunRecord[] | undefined {
  return useRunsStore((s) => s.runs[jobName]);
}
