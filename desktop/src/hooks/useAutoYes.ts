import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClaudeQuestion, DetectedProcess, AutoYesEntry } from "@clawtab/shared";
import type { Job } from "../types";

export function useAutoYes(
  questions: ClaudeQuestion[],
  processes: DetectedProcess[],
  jobs: Job[],
  startFastQuestionPoll: () => void,
) {
  const [autoYesPaneIds, setAutoYesPaneIds] = useState<Set<string>>(new Set());
  const [pendingAutoYes, setPendingAutoYes] = useState<{ paneId: string; title: string } | null>(null);

  const syncAutoYesPaneIds = useCallback((next: Set<string>) => {
    const paneIds = [...next];
    setAutoYesPaneIds(next);
    invoke("set_auto_yes_panes", { paneIds })
      .then(() => invoke<string[]>("get_auto_yes_panes"))
      .then((confirmedPaneIds) => setAutoYesPaneIds(new Set(confirmedPaneIds)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    invoke<string[]>("get_auto_yes_panes").then((paneIds) => {
      setAutoYesPaneIds(new Set(paneIds));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const unlistenPromise = listen("auto-yes-changed", () => {
      invoke<string[]>("get_auto_yes_panes").then((paneIds) => {
        setAutoYesPaneIds(new Set(paneIds));
      }).catch(() => {});
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []);

  const handleToggleAutoYes = useCallback((q: ClaudeQuestion) => {
    if (autoYesPaneIds.has(q.pane_id)) {
      const next = new Set(autoYesPaneIds);
      next.delete(q.pane_id);
      syncAutoYesPaneIds(next);
      return;
    }
    const title = q.matched_job ?? q.cwd.replace(/^\/Users\/[^/]+/, "~");
    setPendingAutoYes({ paneId: q.pane_id, title });
  }, [autoYesPaneIds, syncAutoYesPaneIds]);

  const confirmAutoYes = useCallback(() => {
    if (!pendingAutoYes) return;
    const next = new Set(autoYesPaneIds);
    next.add(pendingAutoYes.paneId);
    syncAutoYesPaneIds(next);
    startFastQuestionPoll();
    setPendingAutoYes(null);
  }, [pendingAutoYes, autoYesPaneIds, startFastQuestionPoll, syncAutoYesPaneIds]);

  const handleToggleAutoYesByPaneId = useCallback((paneId: string, title: string) => {
    if (autoYesPaneIds.has(paneId)) {
      const next = new Set(autoYesPaneIds);
      next.delete(paneId);
      syncAutoYesPaneIds(next);
      return;
    }
    setPendingAutoYes({ paneId, title });
  }, [autoYesPaneIds, syncAutoYesPaneIds]);

  const handleAutoYesPress = useCallback((entry: AutoYesEntry) => {
    if (entry.jobSlug) {
      const job = jobs.find((j) => j.slug === entry.jobSlug);
      if (job) return { kind: "job" as const, job };
    }
    const proc = processes.find((p) => p.pane_id === entry.paneId);
    if (proc) return { kind: "process" as const, process: proc };
    const q = questions.find((q) => q.pane_id === entry.paneId);
    if (q) {
      invoke("focus_detected_process", {
        tmuxSession: q.tmux_session,
        windowName: q.window_name,
      }).catch(() => {});
    }
    return null;
  }, [jobs, processes, questions]);

  const handleDisableAutoYes = useCallback((paneId: string) => {
    const next = new Set(autoYesPaneIds);
    next.delete(paneId);
    syncAutoYesPaneIds(next);
  }, [autoYesPaneIds, syncAutoYesPaneIds]);

  const autoYesEntries: AutoYesEntry[] = useMemo(() => {
    const entries: AutoYesEntry[] = [];
    for (const paneId of autoYesPaneIds) {
      const q = questions.find((q) => q.pane_id === paneId);
      if (q) {
        entries.push({ paneId, label: q.matched_job ?? q.cwd.replace(/^\/Users\/[^/]+/, "~"), jobSlug: q.matched_job });
        continue;
      }
      const proc = processes.find((p) => p.pane_id === paneId);
      if (proc) {
        entries.push({ paneId, label: proc.matched_job ?? proc.cwd.replace(/^\/Users\/[^/]+/, "~"), jobSlug: proc.matched_job });
        continue;
      }
      entries.push({ paneId, label: paneId });
    }
    return entries;
  }, [autoYesPaneIds, questions, processes]);

  return {
    autoYesPaneIds,
    pendingAutoYes,
    setPendingAutoYes,
    handleToggleAutoYes,
    confirmAutoYes,
    handleToggleAutoYesByPaneId,
    handleAutoYesPress,
    handleDisableAutoYes,
    autoYesEntries,
  };
}
