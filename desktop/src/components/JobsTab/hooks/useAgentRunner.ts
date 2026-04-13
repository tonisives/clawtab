import { useCallback, type MutableRefObject } from "react";
import type { DetectedProcess, PaneContent, ProcessProvider, ShellPane, Transport, useJobActions, useJobsCore, useSplitTree } from "@clawtab/shared";
import type { Job } from "../../../types";
import { requestXtermPaneFocus } from "../../XtermPane";
import { providerCapabilities } from "../utils";
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
  defaultProvider,
  lifecycle,
  split,
  transport,
  viewing,
}: UseAgentRunnerParams) {
  const {
    setPendingAgentWorkDir,
    setPendingProcess,
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
    const resolvedProvider = provider ?? defaultProvider;
    const capabilities = providerCapabilities(resolvedProvider);
    if (workDir) {
      const matchingJob = (core.jobs as Job[]).find((j) => j.folder_path === workDir || j.work_dir === workDir);
      const matchedGroup = matchingJob ? (matchingJob.group || "default") : null;
      const launchingShell = resolvedProvider === "shell";
      const placeholder: DetectedProcess = {
        pane_id: `_pending_${Date.now()}`, cwd: workDir, version: "", tmux_session: "", window_name: "",
        provider: resolvedProvider, ...capabilities,
        matched_group: matchedGroup, matched_job: null, log_lines: "", first_query: prompt.slice(0, 80),
        last_query: null, session_started_at: new Date().toISOString(), _transient_state: "starting",
      };

      if (!launchingShell) {
        setPendingProcess(placeholder);
        setShowFolderRunner(false);
        if (split.tree) {
          split.openContent({ kind: "process", paneId: placeholder.pane_id });
        } else {
          setViewingJob(null);
          setViewingAgent(false);
          setViewingShell(null);
          setViewingProcess(placeholder);
        }
        setScrollToSlug(placeholder.pane_id);
      }

      const result = await actions.runAgent(prompt, workDir, provider, model);
      if (result) {
        if (launchingShell) {
          const shellInfo = transport.getExistingPaneInfo
            ? await transport.getExistingPaneInfo(result.pane_id)
            : null;
          const shell: ShellPane = shellInfo ?? {
            pane_id: result.pane_id,
            cwd: workDir,
            tmux_session: result.tmux_session,
            window_name: "",
          };
          const nextShell: ShellPane = { ...shell, matched_group: matchedGroup };
          setShellPanes((prev) => prev.some((pane) => pane.pane_id === nextShell.pane_id) ? prev : [...prev, nextShell]);
          setShowFolderRunner(false);
          if (split.tree) {
            split.openContent({ kind: "terminal", paneId: nextShell.pane_id, tmuxSession: nextShell.tmux_session });
          } else {
            setViewingJob(null);
            setViewingAgent(false);
            setViewingProcess(null);
            setViewingShell(nextShell);
          }
          setScrollToSlug(nextShell.pane_id);
          requestXtermPaneFocus(nextShell.pane_id);
        } else {
          const realProcess: DetectedProcess = {
            pane_id: result.pane_id, cwd: workDir, version: "", tmux_session: result.tmux_session, window_name: "",
            provider: resolvedProvider, ...capabilities,
            matched_group: matchedGroup, matched_job: null, log_lines: "", first_query: prompt.slice(0, 80),
            last_query: null, session_started_at: new Date().toISOString(),
          };
          setPendingProcess(realProcess);
          if (split.tree) {
            const realContent: PaneContent = { kind: "process", paneId: realProcess.pane_id };
            if (!split.replaceContent({ kind: "process", paneId: placeholder.pane_id }, realContent, { focus: false })) {
              split.openContent(realContent);
            }
          } else {
            const activeContent = currentContentRef.current;
            const stillViewingPlaceholder = activeContent?.kind === "process"
              && activeContent.paneId === placeholder.pane_id;
            if (stillViewingPlaceholder) setViewingProcess(realProcess);
          }
          setScrollToSlug(result.pane_id);
          requestXtermPaneFocus(result.pane_id);
          setPendingAgentWorkDir({ dir: workDir, startedAt: Date.now() });
        }
      } else if (!launchingShell) {
        setPendingAgentWorkDir({ dir: workDir, startedAt: Date.now() });
      }
    } else {
      await actions.runAgent(prompt, workDir, provider, model);
    }
  }, [
    actions,
    core.jobs,
    currentContentRef,
    defaultProvider,
    setPendingAgentWorkDir,
    setPendingProcess,
    setScrollToSlug,
    setShellPanes,
    setShowFolderRunner,
    setViewingAgent,
    setViewingJob,
    setViewingProcess,
    setViewingShell,
    split,
    transport,
  ]);

  return { handleRunAgent, handleGetAgentProviders };
}
