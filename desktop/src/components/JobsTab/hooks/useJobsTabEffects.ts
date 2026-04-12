import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { PaneContent, useJobsCore, useSplitTree } from "@clawtab/shared";
import type { Job } from "../../../types";
import { SINGLE_PANE_CACHE_LIMIT, paneContentCacheKey, shouldCacheSinglePaneContent } from "../utils";
import type { useViewingState } from "./useViewingState";

interface UseJobsTabEffectsParams {
  core: ReturnType<typeof useJobsCore>;
  createJobKey?: number;
  isFullScreenView: boolean;
  isWide: boolean;
  onPaneHandled?: () => void;
  pendingPaneId?: string | null;
  pendingTemplateId?: string | null;
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
  setMissedCronJobs,
  split,
  viewing,
}: UseJobsTabEffectsParams) {
  const {
    currentContent,
    setIsCreating,
    setShowPicker,
    setViewingJob,
    setViewingProcess,
    viewingJob,
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

  useEffect(() => {
    if (viewingJob) {
      const fresh = (core.jobs as Job[]).find((j) => j.slug === viewingJob.slug);
      if (fresh && fresh !== viewingJob) setViewingJob(fresh);
    }
  }, [core.jobs, setViewingJob, viewingJob]);

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
