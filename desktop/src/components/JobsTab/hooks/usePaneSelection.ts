import { useCallback } from "react";
import type { DetectedProcess, PaneContent, RemoteJob, ShellPane, useJobsCore, useSplitTree } from "@clawtab/shared";
import { requestXtermPaneFocus } from "../../XtermPane";
import type { useViewingState } from "./useViewingState";

interface UsePaneSelectionParams {
  core: ReturnType<typeof useJobsCore>;
  onJobSelected?: () => void;
  split: ReturnType<typeof useSplitTree>;
  viewing: ReturnType<typeof useViewingState>;
}

export function usePaneSelection({ core, onJobSelected, split, viewing }: UsePaneSelectionParams) {
  const {
    handleSelectJobDirect,
    handleSelectProcessDirect,
    handleSelectShellDirect,
    setShowFolderRunner,
  } = viewing;

  const handleSelectJob = useCallback((job: RemoteJob) => {
    setShowFolderRunner(false);
    const content: PaneContent = { kind: "job", slug: job.slug };
    if (split.tree && split.handleSelectInTree(content)) {
      onJobSelected?.();
      const status = core.statuses[job.slug];
      const paneId = status?.state === "running" ? status.pane_id : undefined;
      if (paneId) requestAnimationFrame(() => requestXtermPaneFocus(paneId));
      return;
    }
    handleSelectJobDirect(job);
  }, [split.tree, split.handleSelectInTree, handleSelectJobDirect, onJobSelected, core.statuses, setShowFolderRunner]);

  const handleSelectProcess = useCallback((process: DetectedProcess) => {
    setShowFolderRunner(false);
    if (process.cwd.endsWith("/clawtab/agent")) {
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
  }, [split.tree, split.handleSelectInTree, handleSelectProcessDirect, onJobSelected, setShowFolderRunner]);

  const handleSelectShell = useCallback((shell: ShellPane) => {
    setShowFolderRunner(false);
    const content: PaneContent = { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session };
    if (split.tree && split.handleSelectInTree(content)) {
      onJobSelected?.();
      requestAnimationFrame(() => requestXtermPaneFocus(shell.pane_id));
      return;
    }
    handleSelectShellDirect(shell);
  }, [split.tree, split.handleSelectInTree, handleSelectShellDirect, onJobSelected, setShowFolderRunner]);

  return { handleSelectJob, handleSelectProcess, handleSelectShell };
}
