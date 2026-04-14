import { useCallback, useMemo } from "react";
import type { DetectedProcess, PaneContent, useJobsCore, useSplitTree } from "@clawtab/shared";
import { collectLeaves } from "@clawtab/shared";
import type { Job } from "../../../types";
import type { useProcessLifecycle } from "../../../hooks/useProcessLifecycle";
import type { useViewingState } from "./useViewingState";

interface UseActivePaneContextParams {
  core: ReturnType<typeof useJobsCore>;
  split: ReturnType<typeof useSplitTree>;
  viewing: ReturnType<typeof useViewingState>;
  lifecycle: ReturnType<typeof useProcessLifecycle>;
}

export function useActivePaneContext({ core, split, viewing, lifecycle }: UseActivePaneContextParams) {
  const { currentContent } = viewing;
  const { pendingProcess, shellPanes } = lifecycle;

  const activePaneContent = useMemo(() => {
    if (!split.tree) return currentContent;
    const leaves = collectLeaves(split.tree);
    return leaves.find((leaf) => leaf.id === split.focusedLeafId)?.content ?? leaves[0]?.content ?? currentContent;
  }, [currentContent, split.focusedLeafId, split.tree]);

  const activeProcessForRename = useMemo<DetectedProcess | null>(() => {
    if (activePaneContent?.kind === "process") {
      return core.processes.find((process) => process.pane_id === activePaneContent.paneId)
        ?? (pendingProcess?.pane_id === activePaneContent.paneId ? pendingProcess : null);
    }
    if (activePaneContent?.kind === "agent") {
      return core.processes.find((process) => process.cwd.endsWith("/clawtab/agent")) ?? null;
    }
    return null;
  }, [activePaneContent, core.processes, pendingProcess]);

  const resolveGroupDisplayKey = useCallback((group: string | null | undefined, folderPath?: string | null) => {
    if (!group || group === "default") {
      return folderPath ? (folderPath.split("/").filter(Boolean).pop() ?? "General") : "General";
    }
    return group;
  }, []);

  const activeSidebarAgentTarget = useMemo(() => {
    if (activePaneContent?.kind === "job") {
      const job = (core.jobs as Job[]).find((entry) => entry.slug === activePaneContent.slug);
      const workDir = job?.folder_path ?? job?.work_dir;
      return job && workDir ? { workDir, groupKey: resolveGroupDisplayKey(job.group, workDir) } : null;
    }
    if (activePaneContent?.kind === "process") {
      const process = core.processes.find((entry) => entry.pane_id === activePaneContent.paneId)
        ?? (pendingProcess?.pane_id === activePaneContent.paneId ? pendingProcess : null);
      if (!process) return null;
      if (process.matched_group) {
        const groupJobs = (core.jobs as Job[]).filter((job) => (job.group || "default") === process.matched_group);
        const workDir = groupJobs[0]?.folder_path ?? groupJobs[0]?.work_dir;
        return workDir ? { workDir, groupKey: resolveGroupDisplayKey(process.matched_group, workDir) } : null;
      }
      const sameFolderCount = core.processes.filter((entry) => !entry.matched_group && entry.cwd === process.cwd).length;
      return sameFolderCount >= 2 ? { workDir: process.cwd, groupKey: `_det_${process.cwd}` } : null;
    }
    if (activePaneContent?.kind === "terminal") {
      const shell = shellPanes.find((entry) => entry.pane_id === activePaneContent.paneId);
      if (!shell?.matched_group) return null;
      const groupJobs = (core.jobs as Job[]).filter((job) => (job.group || "default") === shell.matched_group);
      const workDir = groupJobs[0]?.folder_path ?? groupJobs[0]?.work_dir;
      return workDir ? { workDir, groupKey: resolveGroupDisplayKey(shell.matched_group, workDir) } : null;
    }
    return null;
  }, [activePaneContent, core.jobs, core.processes, pendingProcess, resolveGroupDisplayKey, shellPanes]);

  const getPaneIdForContent = useCallback((content: PaneContent | null): string | null => {
    if (!content) return null;
    if (content.kind === "process" || content.kind === "terminal") return content.paneId;
    if (content.kind !== "job") return null;

    const status = core.statuses[content.slug];
    const statusPaneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id ?? null : null;
    if (statusPaneId) return statusPaneId;

    return core.processes.find((process) => process.matched_job === content.slug)?.pane_id ?? null;
  }, [core.processes, core.statuses]);

  return {
    activePaneContent,
    activeProcessForRename,
    activeAgentWorkDir: activeSidebarAgentTarget?.workDir ?? null,
    getPaneIdForContent,
  };
}
