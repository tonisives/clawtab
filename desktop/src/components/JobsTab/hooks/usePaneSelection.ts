import { useCallback, useEffect, useRef } from "react";
import { collectLeaves, leafContentEquals, type DetectedProcess, type PaneContent, type RemoteJob, type ShellPane, type useJobsCore, type useSplitTree } from "@clawtab/shared";
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

type PendingSelection =
  | { kind: "job"; workspaceId: string; job: RemoteJob }
  | { kind: "process"; workspaceId: string; process: DetectedProcess }
  | { kind: "shell"; workspaceId: string; shell: ShellPane };

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
  const pendingRef = useRef<PendingSelection | null>(null);

  const scheduleCrossWorkspace = useCallback((pending: PendingSelection) => {
    pendingRef.current = pending;
    mgr.ensure(pending.workspaceId);
    // Pre-write the target workspace's singlePaneContent so the workspace-switch
    // restoration effect (useJobsTabEffects) reads the same content we're about
    // to apply to viewing state. Without this, the restoration effect would see
    // whatever was persisted last time for the target workspace and clobber the
    // fresh selection. Only applies when the target has no split tree.
    const targetState = mgr.getState(pending.workspaceId);
    if (!targetState.tree) {
      let content: PaneContent | null = null;
      if (pending.kind === "job") {
        content = { kind: "job", slug: pending.job.slug };
      } else if (pending.kind === "process") {
        const isAgentDir = pending.process.cwd.endsWith("/clawtab/agent");
        content = isAgentDir
          ? { kind: "agent" }
          : { kind: "process", paneId: pending.process.pane_id };
      } else {
        content = { kind: "terminal", paneId: pending.shell.pane_id, tmuxSession: pending.shell.tmux_session };
      }
      mgr.updateState(pending.workspaceId, { singlePaneContent: content });
    }
    mgr.setActive(pending.workspaceId);
  }, [mgr]);

  // Apply a pending cross-workspace selection once the workspace switch commits.
  // Writing to viewing state same-tick as setActive races with useSplitTree's
  // controlled-state effects and corrupts whichever workspace ends up mid-swap.
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (mgr.activeId !== pending.workspaceId) return;
    pendingRef.current = null;

    const targetState = mgr.getState(pending.workspaceId);
    const targetTree = targetState.tree;

    const apply = () => {
      if (pending.kind === "job") {
        const content: PaneContent = { kind: "job", slug: pending.job.slug };
        if (targetTree) {
          const existing = collectLeaves(targetTree).find((leaf) => leafContentEquals(leaf.content, content));
          if (existing) {
            mgr.updateState(pending.workspaceId, { focusedLeafId: existing.id });
            onJobSelected?.();
            const status = core.statuses[pending.job.slug];
            const paneId = status?.state === "running" ? status.pane_id : undefined;
            if (paneId) requestAnimationFrame(() => requestXtermPaneFocus(paneId));
            return;
          }
        }
        handleSelectJobDirect(pending.job);
        return;
      }
      if (pending.kind === "process") {
        const isAgentDir = pending.process.cwd.endsWith("/clawtab/agent");
        const content: PaneContent = isAgentDir
          ? { kind: "agent" }
          : { kind: "process", paneId: pending.process.pane_id };
        if (targetTree) {
          const existing = collectLeaves(targetTree).find((leaf) => leafContentEquals(leaf.content, content));
          if (existing) {
            mgr.updateState(pending.workspaceId, { focusedLeafId: existing.id });
            onJobSelected?.();
            if (!isAgentDir) requestAnimationFrame(() => requestXtermPaneFocus(pending.process.pane_id));
            return;
          }
        }
        handleSelectProcessDirect(pending.process);
        return;
      }
      const content: PaneContent = { kind: "terminal", paneId: pending.shell.pane_id, tmuxSession: pending.shell.tmux_session };
      if (targetTree) {
        const existing = collectLeaves(targetTree).find((leaf) => leafContentEquals(leaf.content, content));
        if (existing) {
          mgr.updateState(pending.workspaceId, { focusedLeafId: existing.id });
          onJobSelected?.();
          requestAnimationFrame(() => requestXtermPaneFocus(pending.shell.pane_id));
          return;
        }
      }
      handleSelectShellDirect(pending.shell);
    };

    apply();
  }, [mgr.activeId, mgr, core.statuses, handleSelectJobDirect, handleSelectProcessDirect, handleSelectShellDirect, onJobSelected]);

  const handleSelectJob = useCallback((job: RemoteJob) => {
    setShowFolderRunner(false);
    const group = groupForJob(job);
    if (group !== mgr.activeId) {
      scheduleCrossWorkspace({ kind: "job", workspaceId: group, job });
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
  }, [mgr.activeId, scheduleCrossWorkspace, split.tree, split.handleSelectInTree, handleSelectJobDirect, onJobSelected, core.statuses, setShowFolderRunner]);

  const handleSelectProcess = useCallback((process: DetectedProcess) => {
    setShowFolderRunner(false);
    const group = groupForProcess(process);
    const isAgentDir = process.cwd.endsWith("/clawtab/agent");
    if (group !== mgr.activeId) {
      scheduleCrossWorkspace({ kind: "process", workspaceId: group, process });
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
  }, [mgr.activeId, scheduleCrossWorkspace, split.tree, split.handleSelectInTree, handleSelectProcessDirect, onJobSelected, setShowFolderRunner]);

  const handleSelectShell = useCallback((shell: ShellPane) => {
    setShowFolderRunner(false);
    const shellWs = shell.workspace_id ?? mgr.activeId;
    if (shellWs !== mgr.activeId) {
      scheduleCrossWorkspace({ kind: "shell", workspaceId: shellWs, shell });
      return;
    }
    const content: PaneContent = { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session };
    if (split.tree && split.handleSelectInTree(content)) {
      onJobSelected?.();
      requestAnimationFrame(() => requestXtermPaneFocus(shell.pane_id));
      return;
    }
    handleSelectShellDirect(shell);
  }, [mgr.activeId, scheduleCrossWorkspace, split.tree, split.handleSelectInTree, handleSelectShellDirect, onJobSelected, setShowFolderRunner]);

  return { handleSelectJob, handleSelectProcess, handleSelectShell };
}
