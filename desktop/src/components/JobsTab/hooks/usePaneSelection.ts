import { useCallback } from "react";
import type { DetectedProcess, PaneContent, RemoteJob, ShellPane, useJobsCore, useSplitTree } from "@clawtab/shared";
import { requestXtermPaneFocus } from "../../XtermPane";
import type { useViewingState } from "./useViewingState";
import type { Job } from "../../../types";
import { useWorkspaceManager } from "../../../workspace/WorkspaceManager";

interface UsePaneSelectionParams {
  core: ReturnType<typeof useJobsCore>;
  onJobSelected?: () => void;
  split: ReturnType<typeof useSplitTree>;
  viewing: ReturnType<typeof useViewingState>;
}

function groupForJob(job: RemoteJob): string {
  return (job as Job).group || "default";
}

function groupForProcess(process: DetectedProcess): string {
  return process.matched_group ?? "default";
}

export function usePaneSelection({ core, onJobSelected, split, viewing }: UsePaneSelectionParams) {
  const {
    handleSelectJobDirect,
    handleSelectProcessDirect,
    handleSelectShellDirect,
    setShowFolderRunner,
  } = viewing;
  const mgr = useWorkspaceManager();

  const handleSelectJob = useCallback((job: RemoteJob) => {
    setShowFolderRunner(false);
    const group = groupForJob(job);
    if (group !== mgr.activeId) {
      mgr.ensure(group);
      mgr.setActive(group);
      handleSelectJobDirect(job);
      return;
    }
    const content: PaneContent = { kind: "job", slug: job.slug };
    if (split.tree && split.handleSelectInTree(content)) {
      onJobSelected?.();
      const status = core.statuses[job.slug];
      const paneId = status?.state === "running" ? status.pane_id : undefined;
      if (paneId) requestAnimationFrame(() => requestXtermPaneFocus(paneId));
      return;
    }
    handleSelectJobDirect(job);
  }, [mgr, split.tree, split.handleSelectInTree, handleSelectJobDirect, onJobSelected, core.statuses, setShowFolderRunner]);

  const handleSelectProcess = useCallback((process: DetectedProcess) => {
    setShowFolderRunner(false);
    const group = groupForProcess(process);
    const isAgentDir = process.cwd.endsWith("/clawtab/agent");
    if (group !== mgr.activeId) {
      mgr.ensure(group);
      mgr.setActive(group);
      handleSelectProcessDirect(process);
      return;
    }
    if (isAgentDir) {
      const content: PaneContent = { kind: "agent" };
      if (split.tree && split.handleSelectInTree(content)) {
        onJobSelected?.();
        return;
      }
      handleSelectProcessDirect(process);
      return;
    }
    const content: PaneContent = { kind: "process", paneId: process.pane_id };
    if (split.tree && split.handleSelectInTree(content)) {
      onJobSelected?.();
      requestAnimationFrame(() => requestXtermPaneFocus(process.pane_id));
      return;
    }
    handleSelectProcessDirect(process);
  }, [mgr, split.tree, split.handleSelectInTree, handleSelectProcessDirect, onJobSelected, setShowFolderRunner]);

  const handleSelectShell = useCallback((shell: ShellPane) => {
    setShowFolderRunner(false);
    const shellWs = shell.workspace_id ?? mgr.activeId;
    if (shellWs !== mgr.activeId) {
      mgr.ensure(shellWs);
      mgr.setActive(shellWs);
      handleSelectShellDirect(shell);
      return;
    }
    const content: PaneContent = { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session };
    if (split.tree && split.handleSelectInTree(content)) {
      onJobSelected?.();
      requestAnimationFrame(() => requestXtermPaneFocus(shell.pane_id));
      return;
    }
    handleSelectShellDirect(shell);
  }, [mgr, split.tree, split.handleSelectInTree, handleSelectShellDirect, onJobSelected, setShowFolderRunner]);

  return { handleSelectJob, handleSelectProcess, handleSelectShell };
}
