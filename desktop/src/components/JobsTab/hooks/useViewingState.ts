import { useCallback, useMemo, useRef, useState } from "react";
import type { RemoteJob } from "@clawtab/shared";
import type { DetectedProcess, ShellPane } from "@clawtab/shared";
import type { PaneContent } from "@clawtab/shared";
import { requestXtermPaneFocus } from "../../XtermPane";
import type { Job } from "../../../types";
import type { ListItemRef } from "../types";

const SINGLE_PANE_STORAGE_KEY = "desktop_single_pane_content";

function loadSinglePaneContent(): PaneContent | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SINGLE_PANE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.kind) return null;
    if (parsed.kind === "job" && typeof parsed.slug === "string") return parsed;
    if (parsed.kind === "agent") return parsed;
    if (parsed.kind === "terminal" && typeof parsed.paneId === "string" && typeof parsed.tmuxSession === "string") return parsed;
    if (parsed.kind === "process" && typeof parsed.paneId === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveSinglePaneContent(content: PaneContent | null) {
  if (typeof localStorage === "undefined") return;
  if (content) localStorage.setItem(SINGLE_PANE_STORAGE_KEY, JSON.stringify(content));
  else localStorage.removeItem(SINGLE_PANE_STORAGE_KEY);
}

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

  // Viewing state - restore from localStorage on mount
  const restoredContent = useRef(loadSinglePaneContent());
  const [viewingJob, setViewingJob] = useState<Job | null>(() => {
    const r = restoredContent.current;
    return r?.kind === "job" ? { slug: r.slug } as Job : null;
  });
  const [viewingProcess, setViewingProcess] = useState<DetectedProcess | null>(null);
  const [viewingShell, setViewingShell] = useState<ShellPane | null>(null);
  const [viewingAgent, setViewingAgent] = useState(() => restoredContent.current?.kind === "agent");
  const [showFolderRunner, setShowFolderRunner] = useState(false);
  // Pending restore for terminal/process kinds (resolved by useJobsTabEffects once data is available)
  const pendingRestore = useRef<PaneContent | null>(
    restoredContent.current?.kind === "terminal" || restoredContent.current?.kind === "process"
      ? restoredContent.current
      : null,
  );

  // Params + misc
  const [paramsDialog, setParamsDialog] = useState<{ job: Job; values: Record<string, string> } | null>(null);
  const scrollSeqRef = useRef(0);
  const [scrollToSlug, setScrollToSlugRaw] = useState<{ slug: string; seq: number } | null>(null);
  const setScrollToSlug = useCallback((slug: string) => {
    scrollSeqRef.current += 1;
    setScrollToSlugRaw({ slug, seq: scrollSeqRef.current });
  }, []);
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
    pendingRestore,
  };
}
