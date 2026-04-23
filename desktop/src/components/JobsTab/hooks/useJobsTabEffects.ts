import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { PaneContent, ShellPane, useJobsCore, useSplitTree } from "@clawtab/shared";
import { collectLeaves } from "@clawtab/shared";
import type { Job } from "../../../types";
import { SINGLE_PANE_CACHE_LIMIT, paneContentCacheKey, shouldCacheSinglePaneContent } from "../utils";
import { saveSinglePaneContent } from "./useViewingState";
import type { useViewingState } from "./useViewingState";
import { useWorkspaceManager } from "../../../workspace/WorkspaceManager";

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
  const mgr = useWorkspaceManager();
  // Tracks the workspace we most recently persisted viewing state into. While
  // this differs from mgr.activeId the workspace-switch effect hasn't yet
  // restored viewing state for the new workspace, and persistence must not
  // write stale (previous-workspace) content into the new workspace's slot.
  const persistedActiveIdRef = useRef<string>(mgr.activeId);
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

  // When the active workspace changes, restore viewing state from the new
  // workspace's persisted singlePaneContent so each workspace shows its own
  // single-pane content instead of the previously-active workspace's.
  useEffect(() => {
    if (persistedActiveIdRef.current === mgr.activeId) return;
    const target = mgr.getState(mgr.activeId);
    // When the new workspace has a tree, the tree owns the view; clear any
    // lingering single-pane viewing state so it doesn't persist back into the
    // workspace's singlePaneContent slot.
    if (target.tree) {
      if (viewingJob) setViewingJob(null);
      if (viewingProcess) setViewingProcess(null);
      if (viewingShell) setViewingShell(null);
      if (viewingAgent) setViewingAgent(false);
      persistedActiveIdRef.current = mgr.activeId;
      return;
    }
    const content = target.singlePaneContent;
    if (!content) {
      if (viewingJob) setViewingJob(null);
      if (viewingProcess) setViewingProcess(null);
      if (viewingShell) setViewingShell(null);
      if (viewingAgent) setViewingAgent(false);
      persistedActiveIdRef.current = mgr.activeId;
      return;
    }
    if (content.kind === "job") {
      const job = (core.jobs as Job[]).find((j) => j.slug === content.slug);
      setViewingJob(job ?? ({ slug: content.slug } as Job));
      if (viewingProcess) setViewingProcess(null);
      if (viewingShell) setViewingShell(null);
      if (viewingAgent) setViewingAgent(false);
      persistedActiveIdRef.current = mgr.activeId;
    } else if (content.kind === "agent") {
      setViewingAgent(true);
      if (viewingJob) setViewingJob(null);
      if (viewingProcess) setViewingProcess(null);
      if (viewingShell) setViewingShell(null);
      persistedActiveIdRef.current = mgr.activeId;
    } else if (content.kind === "process") {
      const proc = core.processes.find((p) => p.pane_id === content.paneId);
      if (proc) {
        setViewingProcess(proc);
        if (viewingJob) setViewingJob(null);
        if (viewingShell) setViewingShell(null);
        if (viewingAgent) setViewingAgent(false);
        persistedActiveIdRef.current = mgr.activeId;
      } else if (core.processes.length > 0) {
        // Processes loaded but this one isn't present — content is stale.
        if (viewingProcess) setViewingProcess(null);
        persistedActiveIdRef.current = mgr.activeId;
      }
      // Else: wait for processes to load; effect re-runs via deps.
    } else if (content.kind === "terminal") {
      const shell = shellPanes.find((s) => s.pane_id === content.paneId);
      if (shell) {
        setViewingShell(shell);
        if (viewingJob) setViewingJob(null);
        if (viewingProcess) setViewingProcess(null);
        if (viewingAgent) setViewingAgent(false);
        persistedActiveIdRef.current = mgr.activeId;
      }
      // Else: wait for shells; effect re-runs via deps.
    }
  }, [mgr, mgr.activeId, core.jobs, core.processes, shellPanes, viewingJob, viewingProcess, viewingShell, viewingAgent, setViewingJob, setViewingProcess, setViewingShell, setViewingAgent]);

  // Persist single-pane content (only when no split tree is active).
  // Skip saving null while a deferred restore is still pending (process/terminal kinds
  // start with null viewing state and get resolved once backend data arrives).
  // Skip entirely while a workspace switch is mid-restore (persistedActiveIdRef
  // still points at the previous workspace) to avoid writing stale viewing
  // state into the new workspace's slot.
  useEffect(() => {
    if (persistedActiveIdRef.current !== mgr.activeId) return;
    if (split.tree) {
      saveSinglePaneContent(null);
      mgr.updateActive({ singlePaneContent: null });
    } else if (currentContent) {
      saveSinglePaneContent(currentContent);
      mgr.updateActive({ singlePaneContent: currentContent });
    } else if (!pendingRestore.current) {
      saveSinglePaneContent(null);
      mgr.updateActive({ singlePaneContent: null });
    }
  }, [split.tree, currentContent, pendingRestore, mgr, mgr.activeId]);

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
