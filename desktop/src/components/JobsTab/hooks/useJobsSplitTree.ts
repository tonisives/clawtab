import { useCallback, useMemo, type MutableRefObject } from "react";
import type { RemoteJob, ShellPane, PaneContent, SplitDragData, useJobsCore } from "@clawtab/shared";
import { useSplitTree } from "@clawtab/shared";
import type { Job } from "../../../types";
import type { useViewingState } from "./useViewingState";
import { useWorkspaceManager } from "../../../workspace/WorkspaceManager";

interface UseJobsSplitTreeParams {
  core: ReturnType<typeof useJobsCore>;
  viewing: ReturnType<typeof useViewingState>;
  shellPanesRef: MutableRefObject<ShellPane[]>;
}

export function useJobsSplitTree({
  core,
  viewing,
  shellPanesRef,
}: UseJobsSplitTreeParams) {
  const {
    currentContent,
    setViewingJob,
    setViewingProcess,
    setViewingShell,
    setViewingAgent,
    handleSelectJobDirect,
    handleSelectProcessDirect,
    handleSelectShellDirect,
  } = viewing;

  const mgr = useWorkspaceManager();
  const activeState = mgr.getState(mgr.activeId);

  const onChange = useCallback((patch: { tree?: ReturnType<typeof mgr.getState>["tree"]; focusedLeafId?: string | null }) => {
    mgr.updateState(mgr.activeId, patch);
  }, [mgr]);

  const controlled = useMemo(() => ({
    id: activeState.id,
    tree: activeState.tree,
    focusedLeafId: activeState.focusedLeafId,
    onChange,
  }), [activeState.id, activeState.tree, activeState.focusedLeafId, onChange]);

  return useSplitTree({
    controlled,
    minPaneSize: 200,
    onCollapse: useCallback((content: PaneContent) => {
      if (content.kind === "job") {
        const job = (core.jobs as Job[]).find(j => j.slug === content.slug);
        if (job) {
          setViewingJob(job);
          setViewingProcess(null);
          setViewingShell(null);
          setViewingAgent(false);
        }
      } else if (content.kind === "process") {
        const proc = core.processes.find(p => p.pane_id === content.paneId);
        if (proc) {
          setViewingProcess(proc);
          setViewingJob(null);
          setViewingShell(null);
          setViewingAgent(false);
        } else {
          const shell = shellPanesRef.current.find(p => p.pane_id === content.paneId);
          if (shell) {
            setViewingShell(shell);
            setViewingJob(null);
            setViewingProcess(null);
            setViewingAgent(false);
          }
        }
      } else if (content.kind === "terminal") {
        const shell = shellPanesRef.current.find((p) => p.pane_id === content.paneId);
        if (shell) {
          setViewingShell(shell);
          setViewingJob(null);
          setViewingProcess(null);
          setViewingAgent(false);
        } else {
          const proc = core.processes.find(p => p.pane_id === content.paneId);
          if (proc) {
            setViewingProcess(proc);
            setViewingJob(null);
            setViewingShell(null);
            setViewingAgent(false);
          }
        }
      } else if (content.kind === "agent") {
        setViewingAgent(true);
        setViewingJob(null);
        setViewingProcess(null);
        setViewingShell(null);
      }
    }, [core.jobs, core.processes, setViewingAgent, setViewingJob, setViewingProcess, setViewingShell, shellPanesRef]),
    onReplaceSingle: useCallback((data: SplitDragData) => {
      if (data.kind === "job") {
        const job = (core.jobs as Job[]).find(j => j.slug === data.slug);
        if (job) handleSelectJobDirect(job as unknown as RemoteJob);
      } else if (data.kind === "process") {
        const proc = core.processes.find(p => p.pane_id === data.paneId);
        if (proc) handleSelectProcessDirect(proc);
      } else if (data.kind === "terminal") {
        const shell = shellPanesRef.current.find((p) => p.pane_id === data.paneId);
        if (shell) handleSelectShellDirect(shell);
      } else if (data.kind === "agent") {
        setViewingAgent(true);
        setViewingJob(null);
        setViewingProcess(null);
        setViewingShell(null);
      }
    }, [core.jobs, core.processes, handleSelectJobDirect, handleSelectProcessDirect, handleSelectShellDirect, setViewingAgent, setViewingJob, setViewingProcess, setViewingShell, shellPanesRef]),
    currentContent,
  });
}
