import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { PaneContent, ShellPane, useJobsCore, useSplitTree } from "@clawtab/shared";
import { collectLeaves } from "@clawtab/shared";
import type { Job } from "../../../types";
import { SINGLE_PANE_CACHE_LIMIT, paneContentCacheKey, shouldCacheSinglePaneContent } from "../utils";
import { saveSinglePaneContent } from "./useViewingState";
import type { useViewingState } from "./useViewingState";

interface UseJobsTabEffectsParams {
  core: ReturnType<typeof useJobsCore>;
  createJobKey?: number;
  isFullScreenView: boolean;
  isWide: boolean;
  onPaneHandled?: () => void;
  pendingPaneId?: string | null;
  pendingTemplateId?: string | null;
  shellPanes: ShellPane[];
  setMissedCronJobs: (names: string[]) => void;
  split: ReturnType<typeof useSplitTree>;
  viewing: ReturnType<typeof useViewingState>;
}

export function useJobsTabEffects({
  core,
  createJobKey,
  isFullScreenView,
  isWide,
  onPaneHandled,
  pendingPaneId,
  pendingTemplateId,
  shellPanes,
  setMissedCronJobs,
  split,
  viewing,
}: UseJobsTabEffectsParams) {
  const {
    currentContent,
    pendingRestore,
    setIsCreating,
    setShowPicker,
    setViewingJob,
    setViewingProcess,
    setViewingShell,
    setViewingAgent,
    viewingJob,
    viewingProcess,
    viewingShell,
    viewingAgent,
  } = viewing;
  const [recentSinglePaneContents, setRecentSinglePaneContents] = useState<PaneContent[]>([]);

  useEffect(() => {
    const unlistenPromise = listen("jobs-changed", () => { core.reload(); });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, [core]);

  useEffect(() => {
    const unlistenPromise = listen<string[]>("missed-cron-jobs", (event) => {
      if (event.payload.length > 0) setMissedCronJobs(event.payload);
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, [setMissedCronJobs]);

  // Hydrate restored job stub with full Job object, or clear if job was deleted
  useEffect(() => {
    if (viewingJob) {
      const fresh = (core.jobs as Job[]).find((j) => j.slug === viewingJob.slug);
      if (fresh && fresh !== viewingJob) setViewingJob(fresh);
      else if (!fresh && core.loaded) setViewingJob(null);
    }
  }, [core.jobs, core.loaded, setViewingJob, viewingJob]);

  // When the focused leaf changes (user clicked or tabbed to another pane), mirror
  // its content into the viewing* state so the sidebar highlight and the shortcut
  // handlers (rename/reveal) target the focused pane instead of the last-selected
  // sidebar item.
  useEffect(() => {
    if (!split.tree || !split.focusedLeafId) return;
    const leaf = collectLeaves(split.tree).find((l) => l.id === split.focusedLeafId);
    if (!leaf) return;
    const content = leaf.content;
    if (content.kind === "job") {
      if (viewingJob?.slug === content.slug) return;
      const job = (core.jobs as Job[]).find((j) => j.slug === content.slug);
      if (!job) return;
      setViewingJob(job);
      if (viewingProcess) setViewingProcess(null);
      if (viewingShell) setViewingShell(null);
      if (viewingAgent) setViewingAgent(false);
    } else if (content.kind === "process") {
      if (viewingProcess?.pane_id === content.paneId) return;
      const proc = core.processes.find((p) => p.pane_id === content.paneId);
      const shell = proc ? null : shellPanes.find((s) => s.pane_id === content.paneId);
      if (proc) {
        setViewingProcess(proc);
        if (viewingJob) setViewingJob(null);
        if (viewingShell) setViewingShell(null);
        if (viewingAgent) setViewingAgent(false);
      } else if (shell) {
        setViewingShell(shell);
        if (viewingJob) setViewingJob(null);
        if (viewingProcess) setViewingProcess(null);
        if (viewingAgent) setViewingAgent(false);
      }
    } else if (content.kind === "terminal") {
      if (viewingShell?.pane_id === content.paneId) return;
      const shell = shellPanes.find((s) => s.pane_id === content.paneId);
      const proc = shell ? null : core.processes.find((p) => p.pane_id === content.paneId);
      if (shell) {
        setViewingShell(shell);
        if (viewingJob) setViewingJob(null);
        if (viewingProcess) setViewingProcess(null);
        if (viewingAgent) setViewingAgent(false);
      } else if (proc) {
        setViewingProcess(proc);
        if (viewingJob) setViewingJob(null);
        if (viewingShell) setViewingShell(null);
        if (viewingAgent) setViewingAgent(false);
      }
    } else if (content.kind === "agent") {
      if (viewingAgent) return;
      setViewingAgent(true);
      if (viewingJob) setViewingJob(null);
      if (viewingProcess) setViewingProcess(null);
      if (viewingShell) setViewingShell(null);
    }
  }, [split.tree, split.focusedLeafId, core.jobs, core.processes, shellPanes, viewingJob, viewingProcess, viewingShell, viewingAgent, setViewingJob, setViewingProcess, setViewingShell, setViewingAgent]);

  useEffect(() => {
    if (!pendingPaneId) return;
    console.log("[open-pane] looking for pane:", pendingPaneId,
      "jobs:", (core.jobs as Job[]).map((j) => ({ slug: j.slug, pane: (core.statuses[j.slug] as { pane_id?: string })?.pane_id })),
      "processes:", core.processes.map((p) => p.pane_id));
    for (const job of core.jobs as Job[]) {
      const status = core.statuses[job.slug];
      if (status?.state === "running") {
        const paneId = (status as { pane_id?: string }).pane_id;
        if (paneId === pendingPaneId) {
          setViewingJob(job);
          onPaneHandled?.();
          return;
        }
      }
    }
    const proc = core.processes.find((p) => p.pane_id === pendingPaneId);
    if (proc) {
      setViewingProcess(proc);
      onPaneHandled?.();
      return;
    }
    if (core.loaded) {
      console.warn("[open-pane] no job or process found for pane:", pendingPaneId);
      onPaneHandled?.();
    }
  }, [core.jobs, core.loaded, core.processes, core.statuses, onPaneHandled, pendingPaneId, setViewingJob, setViewingProcess]);

  useEffect(() => {
    if (pendingTemplateId) setShowPicker(true);
  }, [pendingTemplateId, setShowPicker]);

  useEffect(() => {
    if (createJobKey && createJobKey > 0) setIsCreating(true);
  }, [createJobKey, setIsCreating]);

  useEffect(() => {
    if (split.tree || !currentContent) return;
    setRecentSinglePaneContents((prev) => {
      const key = paneContentCacheKey(currentContent);
      const retained = prev.filter((item) => shouldCacheSinglePaneContent(item));
      const next = shouldCacheSinglePaneContent(currentContent)
        ? [currentContent, ...retained.filter((item) => paneContentCacheKey(item) !== key)]
        : retained;
      return next.slice(0, SINGLE_PANE_CACHE_LIMIT);
    });
  }, [split.tree, currentContent]);

  // Persist single-pane content (only when no split tree is active)
  // Skip saving null while a deferred restore is still pending (process/terminal kinds
  // start with null viewing state and get resolved once backend data arrives).
  useEffect(() => {
    if (split.tree) {
      saveSinglePaneContent(null);
    } else if (currentContent) {
      saveSinglePaneContent(currentContent);
    } else if (!pendingRestore.current) {
      saveSinglePaneContent(null);
    }
  }, [split.tree, currentContent, pendingRestore]);

  // Deferred restoration for terminal/process panes (need backend data to be available)
  // Note: core.loaded tracks jobs, not processes. Processes load via a separate
  // detect_processes call, so we must wait for core.processes to be populated
  // before concluding a process is gone.
  useEffect(() => {
    const pending = pendingRestore.current;
    if (!pending) return;
    if (pending.kind === "terminal") {
      const shell = shellPanes.find((s) => s.pane_id === pending.paneId);
      if (shell) {

        setViewingShell(shell);
        pendingRestore.current = null;
      }
    } else if (pending.kind === "process") {
      const proc = core.processes.find((p) => p.pane_id === pending.paneId);
      if (proc) {

        setViewingProcess(proc);
        pendingRestore.current = null;
      } else if (core.processes.length > 0) {
        // Processes have loaded but this one isn't among them - it's gone
        pendingRestore.current = null;
      }
    }
  }, [shellPanes, core.processes, setViewingShell, setViewingProcess, pendingRestore]);

  useEffect(() => {
    const tabContent = document.querySelector(".tab-content") as HTMLElement | null;
    if (!tabContent) return;
    if (isFullScreenView || !isWide) {
      tabContent.style.overflowY = "auto";
      if (isFullScreenView) tabContent.scrollTop = 0;
    } else {
      tabContent.style.overflowY = "";
    }
    return () => { tabContent.style.overflowY = ""; };
  }, [isFullScreenView, isWide]);

  return { recentSinglePaneContents };
}
