import { useCallback, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaneContent, ProcessProvider, ShellPane, Transport, useJobActions, useJobsCore, useSplitTree } from "@clawtab/shared";
import { requestXtermPaneFocus } from "../../XtermPane";
import type { Job } from "../../../types";
import type { useProcessLifecycle } from "../../../hooks/useProcessLifecycle";
import type { useViewingState } from "./useViewingState";

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

  const handleGetAgentProviders = useCallback(async () => {
    return await transport.listAgentProviders?.() ?? [];
  }, [transport]);

  const handleRunAgent = useCallback(async (prompt: string, workDir?: string, provider?: ProcessProvider, model?: string) => {
    if (!workDir) {
      await actions.runAgent(prompt, workDir, provider, model);
      return;
    }

    const matchingJob = (core.jobs as Job[]).find((j) => j.folder_path === workDir || j.work_dir === workDir);
    const matchedGroup = matchingJob ? (matchingJob.group || null) : null;

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
    };
    setShellPanes((prev) => prev.some((pane) => pane.pane_id === shell.pane_id) ? prev : [...prev, shell]);

    const terminalContent: PaneContent = {
      kind: "terminal",
      paneId: shell.pane_id,
      tmuxSession: shell.tmux_session,
    };

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
    actions,
    core.jobs,
    currentContentRef,
    setPendingAgentWorkDir,
    setScrollToSlug,
    setShellPanes,
    setShowFolderRunner,
    setViewingAgent,
    setViewingJob,
    setViewingProcess,
    setViewingShell,
    split,
  ]);

  return { handleRunAgent, handleGetAgentProviders };
}
