import { useCallback, useMemo, useState } from "react";
import type { RemoteJob } from "@clawtab/shared";
import type { DetectedProcess, ShellPane } from "@clawtab/shared";
import type { PaneContent } from "@clawtab/shared";
import { requestXtermPaneFocus } from "../../XtermPane";
import type { Job } from "../../../types";
import type { ListItemRef } from "../types";

type CoreHook = {
  statuses: Record<string, { state: string; pane_id?: string }>;
};

interface UseViewingStateParams {
  core: CoreHook;
  onJobSelected?: () => void;
}

export function useViewingState({ core, onJobSelected }: UseViewingStateParams) {
  // Editor state
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTemplateId, setPickerTemplateId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [createForGroup, setCreateForGroup] = useState<{ group: string; folderPath: string | null } | null>(null);

  // Viewing state
  const [viewingJob, setViewingJob] = useState<Job | null>(null);
  const [viewingProcess, setViewingProcess] = useState<DetectedProcess | null>(null);
  const [viewingShell, setViewingShell] = useState<ShellPane | null>(null);
  const [viewingAgent, setViewingAgent] = useState(false);
  const [showFolderRunner, setShowFolderRunner] = useState(false);

  // Params + misc
  const [paramsDialog, setParamsDialog] = useState<{ job: Job; values: Record<string, string> } | null>(null);
  const [scrollToSlug, setScrollToSlug] = useState<string | null>(null);
  const [focusEmptyAgentSignal, setFocusEmptyAgentSignal] = useState(0);

  // Compute current single-pane content for the split tree hook
  const currentContent: PaneContent | null = useMemo(() => {
    if (viewingAgent) return { kind: "agent" };
    if (viewingShell) return { kind: "terminal", paneId: viewingShell.pane_id, tmuxSession: viewingShell.tmux_session };
    if (viewingProcess) return { kind: "process", paneId: viewingProcess.pane_id };
    if (viewingJob) return { kind: "job", slug: viewingJob.slug };
    return null;
  }, [viewingAgent, viewingShell, viewingProcess, viewingJob]);

  const handleSelectJobDirect = useCallback((job: RemoteJob) => {
    setShowFolderRunner(false);
    setViewingProcess(null);
    setViewingShell(null);
    setViewingAgent(false);
    setViewingJob(job as Job);
    const status = core.statuses[job.slug];
    const paneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id : undefined;
    if (paneId) requestAnimationFrame(() => requestXtermPaneFocus(paneId));
    onJobSelected?.();
  }, [core.statuses, onJobSelected]);

  const handleSelectProcessDirect = useCallback((process: DetectedProcess) => {
    setShowFolderRunner(false);
    setViewingJob(null);
    setViewingShell(null);
    if (process.cwd.endsWith("/clawtab/agent")) {
      setViewingProcess(null);
      setViewingAgent(true);
      onJobSelected?.();
      return;
    }
    setViewingAgent(false);
    setViewingProcess(process);
    requestAnimationFrame(() => requestXtermPaneFocus(process.pane_id));
    onJobSelected?.();
  }, [onJobSelected]);

  const handleSelectShellDirect = useCallback((shell: ShellPane) => {
    setShowFolderRunner(false);
    setViewingJob(null);
    setViewingProcess(null);
    setViewingAgent(false);
    setViewingShell(shell);
    requestAnimationFrame(() => requestXtermPaneFocus(shell.pane_id));
    onJobSelected?.();
  }, [onJobSelected]);

  const triggerFocusAgentInput = useCallback(() => {
    setEditingJob(null);
    setIsCreating(false);
    setShowPicker(false);
    setPickerTemplateId(null);
    setCreateForGroup(null);
    setSaveError(null);
    setViewingJob(null);
    setViewingProcess(null);
    setViewingShell(null);
    setViewingAgent(false);
    setShowFolderRunner(true);
    setFocusEmptyAgentSignal((value) => value + 1);
  }, []);

  const selectAdjacentItem = useCallback((currentId: string, orderedItems: ListItemRef[]) => {
    const idx = orderedItems.findIndex((it) =>
      it.kind === "job" ? it.slug === currentId : it.paneId === currentId,
    );
    const prevIdx = idx > 0 ? idx - 1 : (orderedItems.length > 1 ? 1 : -1);
    if (prevIdx >= 0 && prevIdx < orderedItems.length) {
      const next = orderedItems[prevIdx];
      if (next.kind === "job") {
        setViewingProcess(null); setViewingShell(null); setViewingAgent(false); setViewingJob(next.job); setScrollToSlug(next.slug);
      } else if (next.kind === "terminal") {
        setViewingJob(null); setViewingProcess(null); setViewingAgent(false); setViewingShell(next.shell); setScrollToSlug(next.paneId);
      } else {
        setViewingJob(null); setViewingShell(null); setViewingAgent(false); setViewingProcess(next.process); setScrollToSlug(next.paneId);
      }
    } else {
      setViewingJob(null); setViewingProcess(null); setViewingShell(null);
    }
  }, []);

  return {
    // Editor state
    editingJob, setEditingJob,
    isCreating, setIsCreating,
    showPicker, setShowPicker,
    pickerTemplateId, setPickerTemplateId,
    saveError, setSaveError,
    createForGroup, setCreateForGroup,
    // Viewing state
    viewingJob, setViewingJob,
    viewingProcess, setViewingProcess,
    viewingShell, setViewingShell,
    viewingAgent, setViewingAgent,
    showFolderRunner, setShowFolderRunner,
    // Params + misc
    paramsDialog, setParamsDialog,
    scrollToSlug, setScrollToSlug,
    focusEmptyAgentSignal,
    setFocusEmptyAgentSignal,
    // Computed
    currentContent,
    // Callbacks
    handleSelectJobDirect,
    handleSelectProcessDirect,
    handleSelectShellDirect,
    triggerFocusAgentInput,
    selectAdjacentItem,
  };
}
