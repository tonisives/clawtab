import { useCallback, useMemo } from "react";
import type { DetectedProcess, useJobsCore } from "@clawtab/shared";
import type { Job } from "../../../types";
import type { ListItemRef } from "../types";
import type { useJobsTabSettings } from "./useJobsTabSettings";
import type { useProcessLifecycle } from "./useProcessLifecycle";
import type { useViewingState } from "./useViewingState";

interface UseSidebarItemsParams {
  core: ReturnType<typeof useJobsCore>;
  settings: ReturnType<typeof useJobsTabSettings>;
  viewing: ReturnType<typeof useViewingState>;
  lifecycle: ReturnType<typeof useProcessLifecycle>;
}

export function useSidebarItems({ core, settings, viewing, lifecycle }: UseSidebarItemsParams) {
  const { jobOrder, processOrder, sortMode } = settings;
  const { pendingProcess, stoppingProcesses, shellPanes } = lifecycle;

  const orderedItems = useMemo(() => {
    const result: ListItemRef[] = [];
    const jobs = core.jobs as Job[];
    const grouped = new Map<string, Job[]>();
    for (const job of jobs) {
      const group = job.group || "default";
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group)!.push(job);
    }
    if (sortMode === "name") {
      for (const [group, groupJobs] of grouped) {
        const manualOrder = jobOrder[group] ?? [];
        const manualIndex = new Map(manualOrder.map((slug, index) => [slug, index]));
        groupJobs.sort((a, b) => {
          const aIndex = manualIndex.get(a.slug);
          const bIndex = manualIndex.get(b.slug);
          if (aIndex != null && bIndex != null) return aIndex - bIndex;
          if (aIndex != null) return -1;
          if (bIndex != null) return 1;
          return a.name.localeCompare(b.name);
        });
      }
    }
    const keys = [...grouped.keys()];
    if (sortMode === "name") {
      keys.sort((a, b) => {
        const da = a === "default" ? "General" : a;
        const db = b === "default" ? "General" : b;
        return da.localeCompare(db, undefined, { sensitivity: "base" });
      });
    }

    const stoppingIds = new Set(stoppingProcesses.map((entry) => entry.process.pane_id));
    const shellPaneIds = new Set(shellPanes.map((shell) => shell.pane_id));
    const allProcesses = [
      ...core.processes.filter((process) => !stoppingIds.has(process.pane_id) && !shellPaneIds.has(process.pane_id)),
      ...stoppingProcesses.map((entry) => entry.process).filter((process) => !shellPaneIds.has(process.pane_id)),
      ...(pendingProcess && !shellPaneIds.has(pendingProcess.pane_id) && !core.processes.some((process) => process.pane_id === pendingProcess.pane_id) ? [pendingProcess] : []),
    ];

    for (const key of keys) {
      for (const job of grouped.get(key) ?? []) result.push({ kind: "job", slug: job.slug, job });
      for (const process of allProcesses) {
        if (process.matched_group === key) result.push({ kind: "process", paneId: process.pane_id, process });
      }
    }
    for (const process of allProcesses) {
      if (!process.matched_group) result.push({ kind: "process", paneId: process.pane_id, process });
    }
    for (const shell of shellPanes) {
      result.push({ kind: "terminal", paneId: shell.pane_id, shell });
    }
    return result;
  }, [core.jobs, core.processes, jobOrder, pendingProcess, shellPanes, sortMode, stoppingProcesses]);

  const detectedProcesses = useMemo(() => {
    const stoppingIds = new Set(stoppingProcesses.map((entry) => entry.process.pane_id));
    const base = stoppingIds.size > 0
      ? core.processes.filter((process) => !stoppingIds.has(process.pane_id))
      : core.processes;
    const baseIds = new Set(base.map((process) => process.pane_id));
    const extras: DetectedProcess[] = [
      ...stoppingProcesses.map((entry) => entry.process),
      ...(pendingProcess && !baseIds.has(pendingProcess.pane_id) ? [pendingProcess] : []),
    ];
    return extras.length > 0 ? [...base, ...extras] : base;
  }, [core.processes, pendingProcess, stoppingProcesses]);

  const selectAdjacentItem = useCallback((currentId: string) => {
    viewing.selectAdjacentItem(currentId, orderedItems);
  }, [orderedItems, viewing]);

  const handleJobReorder = useCallback((sourceSlug: string, targetSlug: string) => {
    const jobs = core.jobs as Job[];
    const sourceJob = jobs.find((job) => job.slug === sourceSlug);
    const targetJob = jobs.find((job) => job.slug === targetSlug);
    if (!sourceJob || !targetJob) return false;
    const sourceGroup = sourceJob.group || "default";
    const targetGroup = targetJob.group || "default";
    if (sourceGroup !== targetGroup) return false;

    const groupJobs = jobs.filter((job) => (job.group || "default") === sourceGroup).slice();
    const manualOrder = jobOrder[sourceGroup] ?? [];
    const manualIndex = new Map(manualOrder.map((slug, index) => [slug, index]));
    groupJobs.sort((a, b) => {
      const aIndex = manualIndex.get(a.slug);
      const bIndex = manualIndex.get(b.slug);
      if (aIndex != null && bIndex != null) return aIndex - bIndex;
      if (aIndex != null) return -1;
      if (bIndex != null) return 1;
      return a.name.localeCompare(b.name);
    });

    const fromIndex = groupJobs.findIndex((job) => job.slug === sourceSlug);
    const toIndex = groupJobs.findIndex((job) => job.slug === targetSlug);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return false;

    const reordered = [...groupJobs];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    settings.persistJobOrder({
      ...jobOrder,
      [sourceGroup]: reordered.map((job) => job.slug),
    });
    return true;
  }, [core.jobs, jobOrder, settings]);

  const handleProcessReorder = useCallback((sourcePaneId: string, targetPaneId: string) => {
    const coreIds = new Set(core.processes.map((process) => process.pane_id));
    const allProcesses = [
      ...core.processes,
      ...stoppingProcesses.map((entry) => entry.process),
      ...(pendingProcess && !coreIds.has(pendingProcess.pane_id) ? [pendingProcess] : []),
    ];
    const sourceProcess = allProcesses.find((process) => process.pane_id === sourcePaneId);
    const targetProcess = allProcesses.find((process) => process.pane_id === targetPaneId);
    if (!sourceProcess || !targetProcess) return false;
    const sourceGroup = sourceProcess.matched_group ?? `cwd:${sourceProcess.cwd}`;
    const targetGroup = targetProcess.matched_group ?? `cwd:${targetProcess.cwd}`;
    if (sourceGroup !== targetGroup) return false;

    const groupProcesses = allProcesses.filter((process) => (process.matched_group ?? `cwd:${process.cwd}`) === sourceGroup);
    const manualOrder = processOrder[sourceGroup] ?? [];
    const manualIndex = new Map(manualOrder.map((paneId, index) => [paneId, index]));
    groupProcesses.sort((a, b) => {
      const aIndex = manualIndex.get(a.pane_id);
      const bIndex = manualIndex.get(b.pane_id);
      if (aIndex != null && bIndex != null) return aIndex - bIndex;
      if (aIndex != null) return -1;
      if (bIndex != null) return 1;
      return (a.display_name ?? a.first_query ?? a.cwd).localeCompare(b.display_name ?? b.first_query ?? b.cwd);
    });

    const fromIndex = groupProcesses.findIndex((process) => process.pane_id === sourcePaneId);
    const toIndex = groupProcesses.findIndex((process) => process.pane_id === targetPaneId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return false;

    const reordered = [...groupProcesses];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    settings.persistProcessOrder({
      ...processOrder,
      [sourceGroup]: reordered.map((process) => process.pane_id),
    });
    return true;
  }, [core.processes, pendingProcess, processOrder, settings, stoppingProcesses]);

  return {
    orderedItems,
    detectedProcesses,
    selectAdjacentItem,
    handleJobReorder,
    handleProcessReorder,
  };
}
