import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaneContent, ProcessProvider, ShellPane, Transport, useJobActions, useJobsCore, useSplitTree } from "@clawtab/shared";
import { requestXtermPaneFocus } from "../../XtermPane";
import type { Job } from "../../../types";
import type { useProcessLifecycle } from "../../../hooks/useProcessLifecycle";
import type { useViewingState } from "./useViewingState";
import { useWorkspaceManager } from "../../../workspace/WorkspaceManager";
import { DETECTED_WORKSPACE_ID } from "../../../workspace/types";

interface UseAgentRunnerParams {
  actions: ReturnType<typeof useJobActions>;
  core: ReturnType<typeof useJobsCore>;
  currentContentRef: MutableRefObject<PaneContent | null>;
  defaultProvider: ProcessProvider;
  lifecycle: ReturnType<typeof useProcessLifecycle>;
  split: ReturnType<typeof useSplitTree>;
  transport: Transport;
  viewing: ReturnType<typeof useViewingState>;
}

interface PendingAgentOpen {
  workspaceId: string;
  shell: ShellPane;
  terminalContent: PaneContent;
}

export function useAgentRunner({
  actions,
  core,
  currentContentRef,
  lifecycle,
  split,
  transport,
  viewing,
}: UseAgentRunnerParams) {
  const {
    setPendingAgentWorkDir,
    setShellPanes,
  } = lifecycle;
  const {
    setScrollToSlug,
    setShowFolderRunner,
    setViewingAgent,
    setViewingJob,
    setViewingProcess,
    setViewingShell,
  } = viewing;
  const mgr = useWorkspaceManager();
  const pendingOpenRef = useRef<PendingAgentOpen | null>(null);

  const handleGetAgentProviders = useCallback(async () => {
    return await transport.listAgentProviders?.() ?? [];
  }, [transport]);

  const applyPaneOpen = useCallback((shell: ShellPane, terminalContent: PaneContent) => {
    setShowFolderRunner(false);
    if (split.tree) {
      split.openContent(terminalContent);
    } else if (currentContentRef.current) {
      const dir = split.detailSize.w >= split.detailSize.h ? "horizontal" : "vertical";
      split.addSplitLeaf("_unused", terminalContent, dir);
      setViewingJob(null);
      setViewingAgent(false);
      setViewingProcess(null);
      setViewingShell(null);
    } else {
      setViewingJob(null);
      setViewingAgent(false);
      setViewingProcess(null);
      setViewingShell(shell);
    }
    setScrollToSlug(shell.pane_id);
    requestXtermPaneFocus(shell.pane_id);
  }, [
    currentContentRef,
    setScrollToSlug,
    setShowFolderRunner,
    setViewingAgent,
    setViewingJob,
    setViewingProcess,
    setViewingShell,
    split,
  ]);

  // Apply a pending pane-open once the workspace switch commits. Writing to
  // split state same-tick as setActive races with useSplitTree's controlled
  // hydration effect and lands the new pane in the previously-active
  // workspace.
  useEffect(() => {
    const pending = pendingOpenRef.current;
    if (!pending) return;
    if (mgr.activeId !== pending.workspaceId) return;
    pendingOpenRef.current = null;
    applyPaneOpen(pending.shell, pending.terminalContent);
  }, [mgr.activeId, split.tree, applyPaneOpen]);

  const handleRunAgent = useCallback(async (prompt: string, workDir?: string, provider?: ProcessProvider, model?: string) => {
    if (!workDir) {
      await actions.runAgent(prompt, workDir, provider, model);
      return;
    }

    const matchingJob = (core.jobs as Job[]).find((j) => j.folder_path === workDir || j.work_dir === workDir);
    const matchedGroup = matchingJob ? (matchingJob.group || null) : null;
    const targetWs = matchingJob ? (matchingJob.group || "default") : DETECTED_WORKSPACE_ID;

    const result = await actions.runAgent(prompt, workDir, provider, model);
    if (!result) {
      setPendingAgentWorkDir({ dir: workDir, startedAt: Date.now() });
      return;
    }

    // Pin the group override so backend detection won't reassign this pane
    invoke("set_detected_process_group", {
      paneId: result.pane_id,
      group: matchedGroup ?? "",
    }).catch(() => {});

    // The backend has created a real tmux pane. Render it as a terminal immediately.
    // If this is claude/codex, the promotion effect in useProcessLifecycle will swap
    // terminal -> process in place once the process is detected inside the pane.
    const shell: ShellPane = {
      pane_id: result.pane_id,
      cwd: workDir,
      tmux_session: result.tmux_session,
      window_name: "",
      matched_group: matchedGroup,
      workspace_id: targetWs,
    };
    setShellPanes((prev) => prev.some((pane) => pane.pane_id === shell.pane_id) ? prev : [...prev, shell]);

    const terminalContent: PaneContent = {
      kind: "terminal",
      paneId: shell.pane_id,
      tmuxSession: shell.tmux_session,
    };

    if (targetWs !== mgr.activeId) {
      // Defer pane-open until the workspace switch commits — applying
      // split mutations same-tick races with useSplitTree's controlled
      // hydration and lands the pane in the wrong workspace.
      pendingOpenRef.current = { workspaceId: targetWs, shell, terminalContent };
      mgr.ensure(targetWs);
      mgr.setActive(targetWs);
      return;
    }

    applyPaneOpen(shell, terminalContent);
  }, [
    actions,
    applyPaneOpen,
    core.jobs,
    mgr,
    setPendingAgentWorkDir,
    setShellPanes,
  ]);

  return { handleRunAgent, handleGetAgentProviders };
}
