import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { DndContext, DragOverlay, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { RemoteJob, JobStatus } from "@clawtab/shared";
import type { DetectedProcess, ClaudeQuestion, ProcessProvider, ShellPane } from "@clawtab/shared";
import {
  JobListView,
  NotificationSection,
  AutoYesBanner,
  SplitDetailArea,
  DropZoneOverlay,
  useJobsCore,
  useJobActions,
  useSplitTree,
  collectLeaves,
  shortenPath,
  type SidebarSelectableItem,
} from "@clawtab/shared";
import type { AutoYesEntry, PaneContent, SplitDragData } from "@clawtab/shared";
import { createTauriTransport } from "../../transport/tauriTransport";
import type { Job } from "../../types";
import { JobEditor } from "../JobEditor";
import { SamplePicker } from "../SamplePicker";
import { ConfirmDialog } from "../ConfirmDialog";
import { ParamsOverlay } from "../ParamsOverlay";
import { DraggableJobCard, DraggableNotificationCard, DraggableProcessCard, DraggableShellCard, type DragData } from "../DraggableCards";
import { EmptyDetailAgent } from "../EmptyDetailAgent";
import { requestXtermPaneFocus } from "../XtermPane";
import { useQuestionPolling } from "../../hooks/useQuestionPolling";
import { useAutoYes } from "../../hooks/useAutoYes";
import { useImportJob } from "../../hooks/useImportJob";
import type { JobsTabProps, ListItemRef } from "./types";
import { SINGLE_PANE_CACHE_LIMIT, paneContentCacheKey, shouldCacheSinglePaneContent, providerCapabilities } from "./utils";
import { useWindowSize } from "./hooks/useWindowSize";
import { useResizablePane } from "./hooks/useResizablePane";
import { useJobsTabSettings } from "./hooks/useJobsTabSettings";
import { Dialogs } from "./components/Dialogs";
import { DragOverlayContent } from "./components/DragOverlayContent";
import { useViewingState } from "./hooks/useViewingState";
import { useProcessLifecycle } from "./hooks/useProcessLifecycle";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { usePaneRenderers } from "./hooks/usePaneRenderers";

const transport = createTauriTransport();

export function JobsTab({ pendingTemplateId, onTemplateHandled, createJobKey, importCwtKey, pendingPaneId, onPaneHandled, navBar, rightPanelOverlay, onJobSelected }: JobsTabProps) {
  const core = useJobsCore(transport, 10000);
  const actions = useJobActions(transport, core.reloadStatuses);
  const settings = useJobsTabSettings();
  const { defaultProvider, groupOrder, jobOrder, processOrder, sortMode, hiddenGroups } = settings;

  // Viewing / navigation state (extracted hook)
  const viewing = useViewingState({ core, onJobSelected });
  const {
    viewingJob, setViewingJob, viewingProcess, setViewingProcess,
    viewingShell, setViewingShell, viewingAgent, setViewingAgent,
    editingJob, setEditingJob, isCreating, setIsCreating,
    showPicker, setShowPicker, pickerTemplateId, setPickerTemplateId,
    saveError, setSaveError, createForGroup, setCreateForGroup,
    showFolderRunner, setShowFolderRunner,
    paramsDialog, setParamsDialog,
    scrollToSlug, setScrollToSlug,
    focusEmptyAgentSignal,
    currentContent,
    handleSelectJobDirect, handleSelectProcessDirect, handleSelectShellDirect,
  } = viewing;
  const currentContentRef = useRef<PaneContent | null>(null);
  currentContentRef.current = currentContent;

  // Ref for shellPanes used by split tree callbacks (lifecycle hook populates it after split)
  const shellPanesRef = useRef<ShellPane[]>([]);
  const focusAgentSignal = 0;
  const renameProcessSignal = 0;
  const [renameProcessPaneId, setRenameProcessPaneId] = useState<string | null>(null);
  const [processRenameDrafts, setProcessRenameDrafts] = useState<Record<string, string | null>>({});
  const [editProcessField, setEditProcessField] = useState<{
    paneId: string;
    title: string;
    label: string;
    field: "display_name";
    initialValue: string;
    placeholder?: string;
  } | null>(null);

  // Split tree (shared hook)

  // Pane action dialogs
  const [skillSearchPaneId, setSkillSearchPaneId] = useState<string | null>(null);
  const [injectSecretsPaneId, setInjectSecretsPaneId] = useState<string | null>(null);

  // Missed cron jobs
  const [missedCronJobs, setMissedCronJobs] = useState<string[]>([]);

  // --- Extracted hooks ---

  const questionPolling = useQuestionPolling();
  const { questions, startFastQuestionPoll } = questionPolling;

  const autoYes = useAutoYes(
    questions,
    core.processes,
    core.jobs as Job[],
    startFastQuestionPoll,
  );

  const split = useSplitTree({
    storageKey: "desktop_split_tree",
    minPaneSize: 200,
    onCollapse: useCallback((content: PaneContent) => {
      if (content.kind === "job") {
        const job = (core.jobs as Job[]).find(j => j.slug === content.slug);
        if (job) { setViewingJob(job); setViewingProcess(null); setViewingShell(null); setViewingAgent(false); }
      } else if (content.kind === "process") {
        const proc = core.processes.find(p => p.pane_id === content.paneId);
        if (proc) { setViewingProcess(proc); setViewingJob(null); setViewingShell(null); setViewingAgent(false); }
      } else if (content.kind === "terminal") {
        const shell = shellPanesRef.current.find((p) => p.pane_id === content.paneId);
        if (shell) { setViewingShell(shell); setViewingJob(null); setViewingProcess(null); setViewingAgent(false); }
      } else if (content.kind === "agent") {
        setViewingAgent(true); setViewingJob(null); setViewingProcess(null); setViewingShell(null);
      }
    }, [core.jobs, core.processes]),
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
    }, [core.jobs, core.processes, handleSelectJobDirect, handleSelectProcessDirect, handleSelectShellDirect]),
    currentContent,
  });

  // Process lifecycle (demotion, promotion, stopping)
  const lifecycle = useProcessLifecycle({ core, split, viewing });
  const {
    pendingProcess, setPendingProcess,
    stoppingProcesses, setStoppingProcesses,
    stoppingJobSlugs, setStoppingJobSlugs,
    shellPanes, setShellPanes,
    demotedShellPaneIdsRef,
    pendingAgentWorkDir, setPendingAgentWorkDir,
  } = lifecycle;
  shellPanesRef.current = shellPanes;

  // Wrap select handlers to check tree first
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
  }, [split.tree, split.handleSelectInTree, handleSelectJobDirect, onJobSelected, core.statuses]);

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
  }, [split.tree, split.handleSelectInTree, handleSelectProcessDirect, onJobSelected]);

  const handleSelectShell = useCallback((shell: ShellPane) => {
    setShowFolderRunner(false);
    const content: PaneContent = { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session };
    if (split.tree && split.handleSelectInTree(content)) {
      onJobSelected?.();
      requestAnimationFrame(() => requestXtermPaneFocus(shell.pane_id));
      return;
    }
    handleSelectShellDirect(shell);
  }, [split.tree, split.handleSelectInTree, handleSelectShellDirect, onJobSelected]);

  const importJob = useImportJob(core.jobs as Job[], core.reload);

  // --- Fork handlers ---

  const handleFork = useCallback(async (paneId: string, direction: "right" | "down" = "down") => {
    try {
      const newPaneId = await invoke<string>("fork_pane", { paneId, direction });
      await core.reload();
      // Add the new pane to the split tree
      const treeDirection = direction === "right" ? "horizontal" as const : "vertical" as const;
      const leaves = split.tree ? collectLeaves(split.tree) : [];
      const sourceLeaf = leaves.find(l => l.content.kind === "process" && l.content.paneId === paneId);
      if (sourceLeaf) {
        split.addSplitLeaf(sourceLeaf.id, { kind: "process", paneId: newPaneId }, treeDirection);
      }
    } catch (e) {
      console.error("fork_pane failed:", e);
    }
  }, [core.reload, split.tree, split.addSplitLeaf]);

  const handleForkWithSecrets = useCallback(async (paneId: string, secretKeys: string[], direction: "right" | "down" = "down") => {
    try {
      const newPaneId = await invoke<string>("fork_pane_with_secrets", { paneId, secretKeys, direction });
      await core.reload();
      const treeDirection = direction === "right" ? "horizontal" as const : "vertical" as const;
      const leaves = split.tree ? collectLeaves(split.tree) : [];
      const sourceLeaf = leaves.find(l => l.content.kind === "process" && l.content.paneId === paneId);
      if (sourceLeaf) {
        split.addSplitLeaf(sourceLeaf.id, { kind: "process", paneId: newPaneId }, treeDirection);
      }
    } catch (e) {
      console.error("fork_pane_with_secrets failed:", e);
    }
  }, [core.reload, split.tree, split.addSplitLeaf]);

  const handleSplitPane = useCallback(async (paneId: string, direction: "right" | "down") => {
    try {
      const baseShell = await invoke<ShellPane>("split_pane_plain", { paneId, direction });
      const sourceProc = core.processes.find((p) => p.pane_id === paneId);
      const sourceShell = shellPanes.find((p) => p.pane_id === paneId);
      const sourceJob = (core.jobs as Job[]).find((job) => {
        const status = core.statuses[job.slug];
        return status?.state === "running" && (status as { pane_id?: string }).pane_id === paneId;
      });
      const shell: ShellPane = {
        ...baseShell,
        matched_group: sourceProc?.matched_group
          ?? sourceShell?.matched_group
          ?? sourceJob?.group
          ?? null,
      };
      setShellPanes((prev) => prev.some((p) => p.pane_id === shell.pane_id) ? prev : [...prev, shell]);
      setScrollToSlug(shell.pane_id);
      const treeDirection = direction === "right" ? "horizontal" as const : "vertical" as const;
      const leaves = split.tree ? collectLeaves(split.tree) : [];
      const sourceLeaf = leaves.find(l => {
        if ((l.content.kind === "process" || l.content.kind === "terminal") && l.content.paneId === paneId) return true;
        if (l.content.kind === "job") {
          const st = core.statuses[l.content.slug];
          return st?.state === "running" && (st as { pane_id?: string }).pane_id === paneId;
        }
        return false;
      });
      const terminalContent: PaneContent = { kind: "terminal", paneId: shell.pane_id, tmuxSession: shell.tmux_session };
      if (sourceLeaf) {
        split.addSplitLeaf(sourceLeaf.id, terminalContent, treeDirection);
      } else if (split.tree) {
        split.openContent(terminalContent);
      } else {
        split.addSplitLeaf("_root", terminalContent, treeDirection);
      }
      requestXtermPaneFocus(shell.pane_id);
    } catch (e) {
      console.error("split_pane_plain failed:", e);
    }
  }, [core.processes, core.jobs, core.statuses, shellPanes, split.tree, split.addSplitLeaf, split.openContent]);

  // --- Settings & event listeners ---

  useEffect(() => {
    const unlistenPromise = listen("jobs-changed", () => { core.reload(); });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, [core.reload]);

  useEffect(() => {
    const unlistenPromise = listen<string[]>("missed-cron-jobs", (event) => {
      if (event.payload.length > 0) setMissedCronJobs(event.payload);
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []);

  // Sync viewing state with reloaded data
  useEffect(() => {
    if (viewingJob) {
      const fresh = (core.jobs as Job[]).find((j) => j.slug === viewingJob.slug);
      if (fresh && fresh !== viewingJob) setViewingJob(fresh);
    }
  }, [core.jobs, viewingJob]);

  useEffect(() => {
    if (!pendingPaneId) return;
    console.log("[open-pane] looking for pane:", pendingPaneId,
      "jobs:", (core.jobs as Job[]).map((j) => ({ slug: j.slug, pane: (core.statuses[j.slug] as { pane_id?: string })?.pane_id })),
      "processes:", core.processes.map((p) => p.pane_id));
    for (const job of core.jobs as Job[]) {
      const status = core.statuses[job.slug];
      if (status?.state === "running") {
        const paneId = (status as { pane_id?: string }).pane_id;
        if (paneId === pendingPaneId) {
          setViewingJob(job);
          onPaneHandled?.();
          return;
        }
      }
    }
    const proc = core.processes.find((p) => p.pane_id === pendingPaneId);
    if (proc) {
      setViewingProcess(proc);
      onPaneHandled?.();
      return;
    }
    if (core.loaded) {
      console.warn("[open-pane] no job or process found for pane:", pendingPaneId);
      onPaneHandled?.();
    }
  }, [pendingPaneId, core.jobs, core.statuses, core.processes, core.loaded, onPaneHandled]);

  useEffect(() => {
    if (pendingTemplateId) setShowPicker(true);
  }, [pendingTemplateId]);

  useEffect(() => {
    if (createJobKey && createJobKey > 0) setIsCreating(true);
  }, [createJobKey]);

  useEffect(() => {
    if (importCwtKey && importCwtKey > 0) importJob.handleImportCwt();
  }, [importCwtKey]);

  // Resizable list pane
  const { listWidth, onResizeHandleMouseDown } = useResizablePane();

  // Responsive
  const { isWide } = useWindowSize();
  const [sidebarSelectableItems, setSidebarSelectableItems] = useState<SidebarSelectableItem[]>([]);
  const [recentSinglePaneContents, setRecentSinglePaneContents] = useState<PaneContent[]>([]);
  const sidebarFocusRef = useRef<{ focus: () => void } | null>(null);
  const activePaneContent = useMemo(() => {
    if (!split.tree) return currentContent;
    const leaves = collectLeaves(split.tree);
    return leaves.find((leaf) => leaf.id === split.focusedLeafId)?.content ?? leaves[0]?.content ?? currentContent;
  }, [currentContent, split.focusedLeafId, split.tree]);
  const activeProcessForRename = useMemo(() => {
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
  const activeAgentWorkDir = activeSidebarAgentTarget?.workDir ?? null;
  const getPaneIdForContent = useCallback((content: PaneContent | null): string | null => {
    if (!content) return null;
    if (content.kind === "process" || content.kind === "terminal") return content.paneId;
    if (content.kind !== "job") return null;

    const status = core.statuses[content.slug];
    return status?.state === "running" ? (status as { pane_id?: string }).pane_id ?? null : null;
  }, [core.statuses]);
  const getProcessDisplayName = useCallback((process: DetectedProcess | null | undefined) => {
    if (!process) return null;
    const draft = processRenameDrafts[process.pane_id];
    if (typeof draft === "string") {
      const trimmed = draft.trim();
      return trimmed || shortenPath(process.cwd);
    }
    return process.display_name ?? shortenPath(process.cwd);
  }, [processRenameDrafts]);

  const openRenameProcessDialog = useCallback((process: DetectedProcess) => {
    setEditProcessField({
      paneId: process.pane_id,
      title: "Edit pane title",
      label: "Title",
      field: "display_name",
      initialValue: process.display_name ?? "",
      placeholder: shortenPath(process.cwd),
    });
  }, []);

  const keyboard = useKeyboardShortcuts({
    core, split, viewing, lifecycle, settings,
    transport,
    activePaneContent, activeProcessForRename,
    setEditProcessField, openRenameProcessDialog,
    handleSplitPane, getPaneIdForContent,
    handleSelectJob, handleSelectProcess, handleSelectShell,
    sidebarSelectableItems, sidebarFocusRef,
  });
  const { sidebarCollapsed } = keyboard;

  useEffect(() => {
    if (split.tree || !currentContent) return;
    setRecentSinglePaneContents((prev) => {
      const key = paneContentCacheKey(currentContent);
      const retained = prev.filter((item) => shouldCacheSinglePaneContent(item));
      const next = shouldCacheSinglePaneContent(currentContent)
        ? [currentContent, ...retained.filter((item) => paneContentCacheKey(item) !== key)]
        : retained;
      return next.slice(0, SINGLE_PANE_CACHE_LIMIT);
    });
  }, [split.tree, currentContent]);

  const isFullScreenView = !isWide && !!(editingJob || isCreating || showPicker);
  const trafficLightInsetStyle = isWide && sidebarCollapsed ? { paddingLeft: 84 } : undefined;
  useEffect(() => {
    const tabContent = document.querySelector(".tab-content") as HTMLElement | null;
    if (!tabContent) return;
    if (isFullScreenView || !isWide) {
      tabContent.style.overflowY = "auto";
      if (isFullScreenView) tabContent.scrollTop = 0;
    } else {
      tabContent.style.overflowY = "";
    }
    return () => { tabContent.style.overflowY = ""; };
  }, [isFullScreenView, isWide]);

  // --- Handlers ---

  const handleRunWithParams = useCallback(async () => {
    if (!paramsDialog) return;
    await actions.runJob(paramsDialog.job.slug, paramsDialog.values);
    setParamsDialog(null);
  }, [paramsDialog, actions]);

  const handleSave = useCallback(async (job: Job) => {
    setSaveError(null);
    try {
      const wasEditing = editingJob;
      const renamed = editingJob && job.name !== editingJob.name;
      if (renamed) {
        await invoke("rename_job", { oldName: editingJob.slug, job: { ...job, slug: "" } });
      } else {
        await invoke("save_job", { job });
      }
      const savedJobs = await invoke<Job[]>("get_jobs");
      const savedJob = savedJobs.find((candidate) => {
        if (wasEditing && candidate.slug === wasEditing.slug) return true;
        return (
          candidate.name === job.name &&
          candidate.job_type === job.job_type &&
          (candidate.group || "default") === (job.group || "default") &&
          (candidate.folder_path ?? "") === (job.folder_path ?? "") &&
          (candidate.work_dir ?? "") === (job.work_dir ?? "")
        );
      }) ?? savedJobs.find((candidate) => candidate.name === job.name);
      await core.reload();
      setEditingJob(null);
      setIsCreating(false);
      setCreateForGroup(null);
      if (savedJob) setViewingJob(savedJob);
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setSaveError(msg);
      console.error("Failed to save job:", e);
    }
  }, [editingJob, core.reload]);

  const handleDuplicate = useCallback(async (job: Job, targetGroup: string) => {
    const allJobs = await invoke<Job[]>("get_jobs");
    const targetJobs = allJobs.filter((j) => (j.group || "default") === targetGroup && j.folder_path);
    const targetProjectPath = targetJobs.length > 0 ? targetJobs[0].folder_path : job.folder_path;
    if (!targetProjectPath) return;
    try {
      const newJob = await invoke<Job>("duplicate_job", { sourceSlug: job.slug, targetProjectPath });
      await core.reload();
      setViewingJob(newJob);
    } catch (e) {
      console.error("Failed to duplicate job:", e);
    }
  }, [core.reload]);

  const handleDuplicateToFolder = useCallback(async (job: Job) => {
    const selected = await open({ directory: true, title: "Choose folder for duplicated job" });
    if (!selected) return;
    const folder = typeof selected === "string" ? selected : selected[0];
    if (!folder) return;
    try {
      const newJob = await invoke<Job>("duplicate_job", { sourceSlug: job.slug, targetProjectPath: folder });
      await core.reload();
      setViewingJob(newJob);
    } catch (e) {
      console.error("Failed to duplicate job:", e);
    }
  }, [core.reload]);

  const handleOpen = useCallback(async (name: string) => {
    await invoke("focus_job_window", { name });
  }, []);


  const handleSaveProcessNameInline = useCallback(async (process: DetectedProcess, name: string) => {
    const normalizedValue = name.trim() || null;
    const paneId = process.pane_id;
    try {
      setProcessRenameDrafts((prev) => {
        if (!(paneId in prev)) return prev;
        const next = { ...prev };
        delete next[paneId];
        return next;
      });
      if (renameProcessPaneId === paneId) setRenameProcessPaneId(null);
      core.setProcesses((prev) => prev.map((proc) => (
        proc.pane_id === paneId ? { ...proc, display_name: normalizedValue } : proc
      )));
      setViewingProcess((prev) => prev && prev.pane_id === paneId
        ? { ...prev, display_name: normalizedValue }
        : prev);
      await invoke("set_detected_process_display_name", {
        paneId,
        displayName: normalizedValue,
      });
      setPendingProcess((prev) => prev && prev.pane_id === paneId
        ? { ...prev, display_name: normalizedValue }
        : prev);
      await core.reloadProcesses();
    } catch (e) {
      console.error("Failed to save process name:", e);
    }
  }, [core, renameProcessPaneId]);

  const handleSaveProcessField = useCallback(async (value: string) => {
    if (!editProcessField) return;
    const normalizedValue = value.trim() || null;
    const paneId = editProcessField.paneId;
    const isShell = shellPanes.some((s) => s.pane_id === paneId) && !core.processes.some((p) => p.pane_id === paneId);
    try {
      if (editProcessField.field === "display_name") {
        if (isShell) {
          setShellPanes((prev) => prev.map((s) => (
            s.pane_id === paneId ? { ...s, display_name: normalizedValue } : s
          )));
          setViewingShell((prev) => prev && prev.pane_id === paneId
            ? { ...prev, display_name: normalizedValue }
            : prev);
        } else {
          core.setProcesses((prev) => prev.map((proc) => (
            proc.pane_id === paneId ? { ...proc, display_name: normalizedValue } : proc
          )));
          setViewingProcess((prev) => prev && prev.pane_id === paneId
            ? { ...prev, display_name: normalizedValue }
            : prev);
          await invoke("set_detected_process_display_name", {
            paneId,
            displayName: normalizedValue,
          });
          setPendingProcess((prev) => prev && prev.pane_id === paneId
            ? { ...prev, display_name: normalizedValue }
            : prev);
        }
      }
      setEditProcessField(null);
      await core.reloadProcesses();
    } catch (e) {
      console.error("Failed to save process edit:", e);
    }
  }, [editProcessField, core, pendingProcess, shellPanes]);

  const orderedItems = useMemo(() => {
    const result: ListItemRef[] = [];
    const jobs = core.jobs as Job[];
    const grouped = new Map<string, Job[]>();
    for (const job of jobs) {
      const group = job.group || "default";
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group)!.push(job);
    }
    if (sortMode === "name") {
      for (const [group, gJobs] of grouped) {
        const manualOrder = jobOrder[group] ?? [];
        const manualIndex = new Map(manualOrder.map((slug, index) => [slug, index]));
        gJobs.sort((a, b) => {
          const aIndex = manualIndex.get(a.slug);
          const bIndex = manualIndex.get(b.slug);
          if (aIndex != null && bIndex != null) return aIndex - bIndex;
          if (aIndex != null) return -1;
          if (bIndex != null) return 1;
          return a.name.localeCompare(b.name);
        });
      }
    }
    const keys = [...grouped.keys()];
    if (sortMode === "name") {
      keys.sort((a, b) => {
        const da = a === "default" ? "General" : a;
        const db = b === "default" ? "General" : b;
        return da.localeCompare(db, undefined, { sensitivity: "base" });
      });
    }
    const stoppingIds = new Set(stoppingProcesses.map((sp) => sp.process.pane_id));
    // A shell pane is authoritative over a stale process entry with the same pane_id.
    // This prevents duplicate sidebar rows + double-selection during demotion races.
    const shellPaneIds = new Set(shellPanes.map((s) => s.pane_id));
    const allProcs = [
      ...core.processes.filter((p) => !stoppingIds.has(p.pane_id) && !shellPaneIds.has(p.pane_id)),
      ...stoppingProcesses.map((sp) => sp.process).filter((p) => !shellPaneIds.has(p.pane_id)),
      ...(pendingProcess && !shellPaneIds.has(pendingProcess.pane_id) && !core.processes.some((p) => p.pane_id === pendingProcess.pane_id) ? [pendingProcess] : []),
    ];
    for (const key of keys) {
      for (const job of grouped.get(key) ?? []) result.push({ kind: "job", slug: job.slug, job });
      for (const proc of allProcs) {
        if (proc.matched_group === key) result.push({ kind: "process", paneId: proc.pane_id, process: proc });
      }
    }
    for (const proc of allProcs) {
      if (!proc.matched_group) result.push({ kind: "process", paneId: proc.pane_id, process: proc });
    }
    for (const shell of shellPanes) {
      result.push({ kind: "terminal", paneId: shell.pane_id, shell });
    }
    return result;
  }, [core.jobs, core.processes, sortMode, jobOrder, pendingProcess, stoppingProcesses, shellPanes]);

  const selectAdjacentItem = useCallback((currentId: string) => {
    viewing.selectAdjacentItem(currentId, orderedItems);
  }, [viewing, orderedItems]);

  const handleJobReorder = useCallback((sourceSlug: string, targetSlug: string) => {
    const jobs = core.jobs as Job[];
    const sourceJob = jobs.find((job) => job.slug === sourceSlug);
    const targetJob = jobs.find((job) => job.slug === targetSlug);
    if (!sourceJob || !targetJob) return false;
    const sourceGroup = sourceJob.group || "default";
    const targetGroup = targetJob.group || "default";
    if (sourceGroup !== targetGroup) return false;

    const groupJobs = jobs.filter((job) => (job.group || "default") === sourceGroup).slice();
    const manualOrder = jobOrder[sourceGroup] ?? [];
    const manualIndex = new Map(manualOrder.map((slug, index) => [slug, index]));
    groupJobs.sort((a, b) => {
      const aIndex = manualIndex.get(a.slug);
      const bIndex = manualIndex.get(b.slug);
      if (aIndex != null && bIndex != null) return aIndex - bIndex;
      if (aIndex != null) return -1;
      if (bIndex != null) return 1;
      return a.name.localeCompare(b.name);
    });

    const fromIndex = groupJobs.findIndex((job) => job.slug === sourceSlug);
    const toIndex = groupJobs.findIndex((job) => job.slug === targetSlug);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return false;

    const reordered = [...groupJobs];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    settings.persistJobOrder({
      ...jobOrder,
      [sourceGroup]: reordered.map((job) => job.slug),
    });
    return true;
  }, [core.jobs, jobOrder, settings.persistJobOrder]);

  const handleProcessReorder = useCallback((sourcePaneId: string, targetPaneId: string) => {
    const coreIds = new Set(core.processes.map((p) => p.pane_id));
    const allProcesses = [...core.processes, ...stoppingProcesses.map((entry) => entry.process), ...(pendingProcess && !coreIds.has(pendingProcess.pane_id) ? [pendingProcess] : [])];
    const sourceProcess = allProcesses.find((process) => process.pane_id === sourcePaneId);
    const targetProcess = allProcesses.find((process) => process.pane_id === targetPaneId);
    if (!sourceProcess || !targetProcess) return false;
    const sourceGroup = sourceProcess.matched_group ?? `cwd:${sourceProcess.cwd}`;
    const targetGroup = targetProcess.matched_group ?? `cwd:${targetProcess.cwd}`;
    if (sourceGroup !== targetGroup) return false;

    const groupProcesses = allProcesses.filter((process) => (process.matched_group ?? `cwd:${process.cwd}`) === sourceGroup);
    const manualOrder = processOrder[sourceGroup] ?? [];
    const manualIndex = new Map(manualOrder.map((paneId, index) => [paneId, index]));
    groupProcesses.sort((a, b) => {
      const aIndex = manualIndex.get(a.pane_id);
      const bIndex = manualIndex.get(b.pane_id);
      if (aIndex != null && bIndex != null) return aIndex - bIndex;
      if (aIndex != null) return -1;
      if (bIndex != null) return 1;
      return (a.display_name ?? a.first_query ?? a.cwd).localeCompare(b.display_name ?? b.first_query ?? b.cwd);
    });

    const fromIndex = groupProcesses.findIndex((process) => process.pane_id === sourcePaneId);
    const toIndex = groupProcesses.findIndex((process) => process.pane_id === targetPaneId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return false;

    const reordered = [...groupProcesses];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    settings.persistProcessOrder({
      ...processOrder,
      [sourceGroup]: reordered.map((process) => process.pane_id),
    });
    return true;
  }, [core.processes, pendingProcess, processOrder, settings.persistProcessOrder, stoppingProcesses]);

  const blurActiveListElement = useCallback(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && typeof active.blur === "function") active.blur();
    });
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    split.handleDragStart(event);
  }, [split.handleDragStart]);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    split.handleDragMove(event);
  }, [split.handleDragMove]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const data = event.active.data.current as DragData | null;
    const overId = typeof event.over?.id === "string" ? event.over.id : null;
    if (data?.kind === "job" && data.source === "sidebar" && overId) {
      handleJobReorder(data.slug, overId);
    }
    if (data?.kind === "process" && data.source === "sidebar" && overId) {
      handleProcessReorder(data.paneId, overId);
    }
    split.handleDragEnd(event);
    blurActiveListElement();
  }, [blurActiveListElement, handleJobReorder, handleProcessReorder, split.handleDragEnd]);

  const handleDragCancel = useCallback(() => {
    split.handleDragCancel();
    blurActiveListElement();
  }, [blurActiveListElement, split.handleDragCancel]);

  const handleGetAgentProviders = useCallback(async () => {
    return await transport.listAgentProviders?.() ?? [];
  }, []);

  const handleRunAgent = useCallback(async (prompt: string, workDir?: string, provider?: ProcessProvider) => {
    const resolvedProvider = provider ?? defaultProvider;
    const capabilities = providerCapabilities(resolvedProvider);
    if (workDir) {
      const matchingJob = (core.jobs as Job[]).find((j) => j.folder_path === workDir || j.work_dir === workDir);
      const matchedGroup = matchingJob ? (matchingJob.group || "default") : null;
      const launchingShell = resolvedProvider === "shell";
      // Show a placeholder while waiting for the pane to be created
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
          setViewingJob(null); setViewingAgent(false); setViewingShell(null); setViewingProcess(placeholder);
        }
        setScrollToSlug(placeholder.pane_id);
      }

      const result = await actions.runAgent(prompt, workDir, provider);
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
            setViewingJob(null); setViewingAgent(false); setViewingProcess(null); setViewingShell(nextShell);
          }
          setScrollToSlug(nextShell.pane_id);
          requestXtermPaneFocus(nextShell.pane_id);
        } else {
          // Got the real pane - switch to it immediately
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
          // Clear pending state after next process poll picks it up
          setPendingAgentWorkDir({ dir: workDir, startedAt: Date.now() });
        }
      } else {
        // Fallback: poll for the process (timeout case)
        if (!launchingShell) setPendingAgentWorkDir({ dir: workDir, startedAt: Date.now() });
      }
    } else {
      await actions.runAgent(prompt, workDir, provider);
    }
  }, [actions, core.jobs, defaultProvider, split.tree, split.openContent, split.replaceContent]);

  const handleAddJob = useCallback((group: string, folderPath?: string) => {
    if (folderPath) {
      const cleanGroup = group.startsWith("_det_")
        ? group.slice(5).split("/").filter(Boolean).pop() ?? group
        : group;
      setCreateForGroup({ group: cleanGroup, folderPath });
      setIsCreating(true);
      return;
    }
    const jobs = core.jobs as Job[];
    const groupJobs = jobs.filter((j) => (j.group || "default") === group);
    const isFolderGroup = groupJobs.length > 0 && groupJobs.every((j) => j.job_type === "job");
    setCreateForGroup({
      group,
      folderPath: isFolderGroup ? groupJobs[0]?.folder_path ?? null : null,
    });
    setIsCreating(true);
  }, [core.jobs]);

  const handleQuestionNavigate = useCallback((q: ClaudeQuestion, resolvedJob: string | null) => {
    questionPolling.handleQuestionNavigate(q, resolvedJob, core.jobs as Job[], core.processes, setViewingJob, setViewingProcess);
  }, [core.jobs, core.processes, questionPolling]);

  const handleAutoYesPress = useCallback((entry: AutoYesEntry) => {
    const result = autoYes.handleAutoYesPress(entry);
    if (!result) return;
    if (result.kind === "job") { setViewingJob(result.job as Job); return; }
    if (result.kind === "process") { setViewingProcess(result.process); return; }
  }, [autoYes]);

  const handleRunMissedJobs = useCallback(async () => {
    const jobNames = missedCronJobs;
    setMissedCronJobs([]);
    for (const name of jobNames) {
      const job = (core.jobs as Job[]).find((j) => j.name === name);
      if (job) await actions.runJob(job.slug);
    }
  }, [missedCronJobs, core.jobs, actions]);

  const folderRunGroups = useMemo(() => {
    const seen = new Set<string>();
    const out: { group: string; folderPath: string }[] = [];
    for (const job of core.jobs as Job[]) {
      const folderPath = (job.folder_path ?? job.work_dir)?.replace(/\/+$/, "");
      if (!folderPath || seen.has(folderPath)) continue;
      seen.add(folderPath);
      out.push({
        group: job.group && job.group !== "default"
          ? job.group
          : folderPath.split("/").filter(Boolean).pop() ?? "General",
        folderPath,
      });
    }
    return out;
  }, [core.jobs]);

  // Helper: build DesktopJobDetail pane action props
  const buildJobPaneActions = useCallback((job: Job, jobQuestion: ClaudeQuestion | undefined) => ({
    autoYesActive: (() => {
      const paneId = jobQuestion?.pane_id ?? (core.statuses[job.slug]?.state === "running" ? (core.statuses[job.slug] as { pane_id?: string }).pane_id : undefined);
      return paneId ? autoYes.autoYesPaneIds.has(paneId) : false;
    })(),
    onToggleAutoYes: (() => {
      if (jobQuestion) return () => autoYes.handleToggleAutoYes(jobQuestion);
      const status = core.statuses[job.slug];
      if (status?.state === "running") {
        const paneId = (status as { pane_id?: string }).pane_id;
        if (paneId) return () => autoYes.handleToggleAutoYesByPaneId(paneId, job.name);
      }
      return undefined;
    })(),
    onFork: (() => {
      const status = core.statuses[job.slug];
      const paneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id : undefined;
      return paneId ? (direction: "right" | "down") => handleFork(paneId, direction) : undefined;
    })(),
    onSplitPane: (() => {
      const status = core.statuses[job.slug];
      const paneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id : undefined;
      return paneId ? (direction: "right" | "down") => handleSplitPane(paneId, direction) : undefined;
    })(),
    onInjectSecrets: (() => {
      const status = core.statuses[job.slug];
      const paneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id : undefined;
      return paneId ? () => setInjectSecretsPaneId(paneId) : undefined;
    })(),
    onSearchSkills: (() => {
      const status = core.statuses[job.slug];
      const paneId = status?.state === "running" ? (status as { pane_id?: string }).pane_id : undefined;
      return paneId ? () => setSkillSearchPaneId(paneId) : undefined;
    })(),
    onZoomPane: () => {
      if (split.tree) {
        const leaves = collectLeaves(split.tree);
        const currentLeaf = leaves.find((leaf) => leaf.content.kind === "job" && leaf.content.slug === job.slug);
        if (currentLeaf) {
          split.toggleZoomLeaf(currentLeaf.id);
          return;
        }
      }
      split.toggleZoomLeaf("");
    },
  }), [core.statuses, autoYes, handleFork, handleSplitPane, split.tree, split.toggleZoomLeaf]);

  const buildJobTitlePath = useCallback((job: Job, _jobQuestion: ClaudeQuestion | undefined) => {
    const sourcePath = job.work_dir || job.folder_path || job.path;
    return sourcePath ? shortenPath(sourcePath) : undefined;
  }, []);

  const buildProcessTitlePath = useCallback((process: DetectedProcess) => {
    return shortenPath(process.cwd);
  }, []);

  const agentProcess = useMemo(
    () => core.processes.find((process) => process.cwd.endsWith("/clawtab/agent")) ?? null,
    [core.processes],
  );

  const agentJob = useMemo<RemoteJob>(() => ({
    name: getProcessDisplayName(agentProcess) ?? agentProcess?.first_query ?? "agent",
    job_type: "claude",
    enabled: true,
    cron: "",
    group: "",
    slug: "agent",
  }), [agentProcess, getProcessDisplayName]);

  const { renderLeaf, renderSinglePaneContent } = usePaneRenderers({
    core, split, viewing, lifecycle, actions,
    questions, questionPolling, autoYes, transport,
    agentJob, agentProcess,
    isWide, trafficLightInsetStyle, defaultProvider,
    callbacks: {
      handleOpen, handleDuplicate, handleDuplicateToFolder,
      handleFork, handleSplitPane,
      handleRunAgent, handleGetAgentProviders,
      selectAdjacentItem, openRenameProcessDialog,
      buildJobPaneActions, buildJobTitlePath, buildProcessTitlePath,
      setEditingJob, setSkillSearchPaneId, setInjectSecretsPaneId,
      processRenameDrafts, folderRunGroups,
    },
  });

  // Custom card renderers for drag-and-drop
  const renderDraggableJobCard = useCallback(
    (props: { job: RemoteJob; group: string; indexInGroup: number; status: JobStatus; onPress?: () => void; selected?: string | boolean; onStop?: () => void; autoYesActive?: boolean; stopping?: boolean; marginTop?: number; dimmed?: boolean; dataJobSlug?: string; defaultAgentProvider?: ProcessProvider }) => (
      <DraggableJobCard
        {...props}
        reorderEnabled={sortMode === "name"}
        defaultAgentProvider={defaultProvider}
      />
    ),
    [sortMode, defaultProvider],
  );

  const renderDraggableProcessCard = useCallback(
    (props: { process: DetectedProcess; sortGroup: string; onPress?: () => void; inGroup?: boolean; selected?: string | boolean; onStop?: () => void; onRename?: () => void; onSaveName?: (name: string) => void; autoYesActive?: boolean; marginTop?: number; dataProcessId?: string; startRenameSignal?: number; onRenameDraftChange?: (value: string | null) => void; onRenameStateChange?: (editing: boolean) => void }) => (
      <DraggableProcessCard
        {...props}
        reorderEnabled
      />
    ),
    [],
  );

  const renderDraggableShellCard = useCallback(
    (props: { shell: ShellPane; onPress?: () => void; selected?: boolean | string; onStop?: () => void; onRename?: () => void }) => (
      <DraggableShellCard {...props} />
    ),
    [],
  );

  const wrapSortableJobGroup = useCallback((group: string, jobSlugs: string[], children: React.ReactNode) => (
    <SortableContext
      key={`sortable-${group}`}
      items={jobSlugs}
      strategy={verticalListSortingStrategy}
    >
      {children}
    </SortableContext>
  ), []);

  const wrapSortableProcessGroup = useCallback((group: string, processPaneIds: string[], children: React.ReactNode) => (
    <SortableContext
      key={`sortable-process-${group}`}
      items={processPaneIds}
      strategy={verticalListSortingStrategy}
    >
      {children}
    </SortableContext>
  ), []);

  // --- Notification visibility ---

  const [nfnVisible, setNfnVisible] = useState(questions.length > 0);
  const nfnHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (questions.length > 0) {
      if (nfnHideTimer.current) clearTimeout(nfnHideTimer.current);
      setNfnVisible(true);
    } else {
      nfnHideTimer.current = setTimeout(() => setNfnVisible(false), 500);
    }
    return () => { if (nfnHideTimer.current) clearTimeout(nfnHideTimer.current); };
  }, [questions.length]);

  const notificationSection = useMemo(() => {
    if (!nfnVisible && autoYes.autoYesEntries.length === 0) return undefined;
    return (
      <>
        <AutoYesBanner entries={autoYes.autoYesEntries} onDisable={autoYes.handleDisableAutoYes} onPress={handleAutoYesPress} />
        {nfnVisible && (
          <NotificationSection
            questions={questions}
            resolveJob={questionPolling.resolveQuestionJob}
            onNavigate={handleQuestionNavigate}
            onSendOption={questionPolling.handleQuestionSendOption}
            collapsed={core.collapsedGroups.has("Notifications")}
            onToggleCollapse={() => core.toggleGroup("Notifications")}
            autoYesPaneIds={autoYes.autoYesPaneIds}
            onToggleAutoYes={autoYes.handleToggleAutoYes}
            wrapQuestionCard={isWide ? (question, card) => (
              <DraggableNotificationCard
                question={question}
                resolvedJob={questionPolling.resolveQuestionJob(question)}
              >
                {card}
              </DraggableNotificationCard>
            ) : undefined}
          />
        )}
      </>
    );
  }, [nfnVisible, questions, questionPolling, handleQuestionNavigate, core.collapsedGroups, core.toggleGroup, autoYes, handleAutoYesPress, isWide]);

  // --- Render ---

  const isEditorVisible = !!(editingJob || isCreating);
  const isPickerVisible = showPicker && !isEditorVisible;
  const isMainVisible = isWide || (!isEditorVisible && !isPickerVisible);
  const panelContentStyle: CSSProperties = {
    flex: 1,
    overflow: "auto",
    paddingTop: 28,
    paddingRight: 20,
    paddingBottom: 20,
    paddingLeft: isWide && sidebarCollapsed ? 104 : 20,
  };

  const folderRunnerPane = (
    <EmptyDetailAgent
      onRunAgent={handleRunAgent}
      getAgentProviders={handleGetAgentProviders}
      defaultProvider={defaultProvider}
      focusSignal={focusEmptyAgentSignal}
      folderGroups={folderRunGroups}
    />
  );

  const detailPane = !showFolderRunner && currentContent ? (
    <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
      {shouldCacheSinglePaneContent(currentContent) ? (
        recentSinglePaneContents.map((content) => {
          const key = paneContentCacheKey(content);
          const isActive = paneContentCacheKey(currentContent) === key;
          return (
            <div
              key={key}
              style={{
                display: isActive ? "flex" : "none",
                flexDirection: "column",
                position: "absolute",
                inset: 0,
                overflow: "hidden",
              }}
            >
              {renderSinglePaneContent(content)}
            </div>
          );
        })
      ) : (
        <div
          key={paneContentCacheKey(currentContent)}
          style={{
            display: "flex",
            flexDirection: "column",
            position: "absolute",
            inset: 0,
            overflow: "hidden",
          }}
        >
          {renderSinglePaneContent(currentContent)}
        </div>
      )}
      {paramsDialog && currentContent.kind === "job" && (
        <ParamsOverlay
          job={paramsDialog.job} values={paramsDialog.values}
          onChange={(values) => setParamsDialog({ ...paramsDialog, values })}
          onRun={handleRunWithParams} onCancel={() => setParamsDialog(null)}
        />
      )}
      {autoYes.pendingAutoYes && (currentContent.kind === "job" || currentContent.kind === "process") && (
        <ConfirmDialog
          message={`Enable auto-yes for "${autoYes.pendingAutoYes.title}"?\n\nAll future questions will be automatically accepted with "Yes". This stays active until you disable it.`}
          onConfirm={autoYes.confirmAutoYes} onCancel={() => autoYes.setPendingAutoYes(null)}
          confirmLabel="Enable" confirmClassName="btn btn-sm"
        />
      )}
    </div>
  ) : (
    folderRunnerPane
  );

  const dialogs = (
    <Dialogs
      paramsDialog={paramsDialog}
      setParamsDialog={setParamsDialog}
      handleRunWithParams={handleRunWithParams}
      viewingJob={viewingJob}
      viewingProcess={viewingProcess}
      autoYesPending={autoYes.pendingAutoYes}
      onConfirmAutoYes={autoYes.confirmAutoYes}
      onCancelAutoYes={() => autoYes.setPendingAutoYes(null)}
      importState={importJob.importState}
      onImportPickDest={importJob.handleImportPickDest}
      onImportDuplicate={importJob.handleImportDuplicate}
      onCancelImport={() => importJob.setImportState(null)}
      importError={importJob.importError}
      onClearImportError={() => importJob.setImportError(null)}
      missedCronJobs={missedCronJobs}
      onRunMissedJobs={handleRunMissedJobs}
      onClearMissedJobs={() => setMissedCronJobs([])}
      skillSearchPaneId={skillSearchPaneId}
      setSkillSearchPaneId={setSkillSearchPaneId}
      injectSecretsPaneId={injectSecretsPaneId}
      setInjectSecretsPaneId={setInjectSecretsPaneId}
      onForkWithSecrets={handleForkWithSecrets}
      editProcessField={editProcessField}
      setEditProcessField={() => setEditProcessField(null)}
      onSaveProcessField={handleSaveProcessField}
    />
  );

  const detectedProcessesMemo = useMemo(() => {
    const stoppingIds = new Set(stoppingProcesses.map((sp) => sp.process.pane_id));
    const base = stoppingIds.size > 0
      ? core.processes.filter((p) => !stoppingIds.has(p.pane_id))
      : core.processes;
    const baseIds = new Set(base.map((p) => p.pane_id));
    const extras = [
      ...stoppingProcesses.map((sp) => sp.process),
      ...(pendingProcess && !baseIds.has(pendingProcess.pane_id) ? [pendingProcess] : []),
    ];
    return extras.length > 0 ? [...base, ...extras] : base;
  }, [stoppingProcesses, core.processes, pendingProcess]);

  const jobListView = (
    <JobListView
      jobs={core.jobs}
      statuses={core.statuses}
      detectedProcesses={detectedProcessesMemo}
      shellPanes={shellPanes}
      collapsedGroups={core.collapsedGroups}
      onToggleGroup={core.toggleGroup}
      groupOrder={groupOrder}
      jobOrder={jobOrder}
      processOrder={processOrder}
      sortMode={sortMode}
      onSortChange={settings.setSortMode}
      onSelectJob={handleSelectJob}
      onSelectProcess={handleSelectProcess}
      onSelectShell={handleSelectShell}
      selectedItems={split.selectedItems}
      focusedItemKey={split.focusedItemKey}
      onRunAgent={handleRunAgent}
      getAgentProviders={handleGetAgentProviders}
      defaultAgentProvider={defaultProvider}
      onAddJob={handleAddJob}
      hiddenGroups={hiddenGroups}
      onHideGroup={settings.handleHideGroup}
      onUnhideGroup={settings.handleUnhideGroup}
      headerContent={notificationSection}
      showEmpty={core.loaded}
      emptyMessage="No jobs configured yet."
      scrollToSlug={scrollToSlug}
      scrollEnabled={!split.isDragging}
      onSelectableItemsChange={setSidebarSelectableItems}
      sidebarFocusRef={sidebarFocusRef}
      onStopJob={(slug) => {
        setStoppingJobSlugs((prev) => new Set(prev).add(slug));
        core.requestFastPoll(`job:${slug}`);
        transport.stopJob(slug);
      }}
      onStopProcess={(paneId) => {
        const proc = core.processes.find((p) => p.pane_id === paneId);
        if (proc) {
          setStoppingProcesses((prev) => {
            if (prev.some((sp) => sp.process.pane_id === paneId)) return prev;
            return [...prev, { process: { ...proc, _transient_state: "stopping" }, stoppedAt: Date.now() }];
          });
        }
        core.requestFastPoll(`pane:${paneId}`);
        invoke("stop_detected_process", { paneId });
      }}
      onRenameProcess={openRenameProcessDialog}
      onSaveProcessName={handleSaveProcessNameInline}
      focusAgentWorkDir={activeAgentWorkDir}
      focusAgentSignal={focusAgentSignal}
      renameProcessPaneId={renameProcessPaneId}
      renameProcessSignal={renameProcessSignal}
      onProcessRenameDraftChange={(paneId, value) => {
        setProcessRenameDrafts((prev) => {
          if (value === null) {
            if (!(paneId in prev)) return prev;
            const next = { ...prev };
            delete next[paneId];
            return next;
          }
          if (prev[paneId] === value) return prev;
          return { ...prev, [paneId]: value };
        });
      }}
      onProcessRenameStateChange={(paneId, editing) => {
        if (!editing && renameProcessPaneId === paneId) {
          setRenameProcessPaneId(null);
        }
      }}
      onStopShell={(paneId) => {
        demotedShellPaneIdsRef.current.delete(paneId);
        setShellPanes((prev) => prev.filter((p) => p.pane_id !== paneId));
        if (viewingShell?.pane_id === paneId) selectAdjacentItem(paneId);
        invoke("stop_detected_process", { paneId });
      }}
      onRenameShell={(shell) => {
        setEditProcessField({
          paneId: shell.pane_id,
          title: "Edit pane title",
          label: "Title",
          field: "display_name",
          initialValue: shell.display_name ?? "",
          placeholder: shortenPath(shell.cwd),
        });
      }}
      autoYesPaneIds={autoYes.autoYesPaneIds}
      renderJobCard={isWide ? renderDraggableJobCard : undefined}
      renderProcessCard={isWide ? renderDraggableProcessCard : undefined}
      renderShellCard={isWide ? renderDraggableShellCard : undefined}
      wrapJobGroup={isWide && sortMode === "name" ? wrapSortableJobGroup : undefined}
      wrapProcessGroup={isWide ? wrapSortableProcessGroup : undefined}
      stoppingSlugs={stoppingJobSlugs}
    />
  );

  const dragOverlayContent = (
    <DragOverlayContent
      dragOverlayData={split.dragOverlayData as DragData | null}
      statuses={core.statuses}
      autoYesPaneIds={autoYes.autoYesPaneIds}
    />
  );

  const dropOverlay = split.isDragging ? (
    <DropZoneOverlay
      tree={split.effectiveTreeForOverlay}
      containerW={split.detailSize.w}
      containerH={split.detailSize.h}
      activeZone={split.dragActiveZone}
    />
  ) : null;

  return (
    <>
      {/* Editor view - full screen only on narrow layouts */}
      <div style={{ display: !isWide && isEditorVisible ? undefined : "none", height: "100%" }}>
        {saveError && (
          <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--danger-bg, #2d1b1b)", border: "1px solid var(--danger, #e55)", borderRadius: 4, fontSize: 13 }}>
            Save failed: {saveError}
          </div>
        )}
        {!isWide && isEditorVisible && (
          <div style={panelContentStyle}>
            <JobEditor
              job={editingJob}
              onSave={handleSave}
              onCancel={() => {
                if (editingJob) setViewingJob(editingJob);
                setEditingJob(null); setIsCreating(false); setCreateForGroup(null); setSaveError(null);
              }}
              headerMode="back"
              onPickTemplate={(templateId) => {
                setIsCreating(false); setCreateForGroup(null);
                setPickerTemplateId(templateId); setShowPicker(true);
              }}
              defaultGroup={createForGroup?.group}
              defaultFolderPath={createForGroup?.folderPath ?? undefined}
            />
          </div>
        )}
      </div>

      {/* Picker view - full screen only on narrow layouts */}
      <div style={{ display: !isWide && isPickerVisible ? undefined : "none", height: "100%" }}>
        {!isWide && isPickerVisible && (
          <div style={panelContentStyle}>
            <SamplePicker
              autoCreateTemplateId={pickerTemplateId ?? pendingTemplateId ?? undefined}
              headerMode="back"
              onCreated={() => {
                setShowPicker(false); setPickerTemplateId(null);
                onTemplateHandled?.(); core.reload();
              }}
              onBlank={() => {
                setShowPicker(false); setPickerTemplateId(null);
                onTemplateHandled?.(); setIsCreating(true);
              }}
              onCancel={() => {
                setShowPicker(false); setPickerTemplateId(null);
                onTemplateHandled?.();
              }}
            />
          </div>
        )}
      </div>

      {/* Main view */}
      <div style={{ display: isMainVisible ? undefined : "none", height: "100%" }}>
        {!isWide ? (
          (showFolderRunner || viewingAgent || pendingAgentWorkDir || viewingProcess || viewingShell || viewingJob) ? (
            <div style={{ height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}>
              {navBar}
              {detailPane}
              {dialogs}
            </div>
          ) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {navBar}
              {jobListView}
              {dialogs}
            </div>
          )
        ) : (
          <DndContext
            sensors={split.sensors}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div style={{ display: "flex", flexDirection: "row", height: "100%", overflow: "hidden" }}>
              {!sidebarCollapsed && (
                <>
                  <div style={{ width: listWidth, minWidth: 260, maxWidth: 600, borderRight: "1px solid var(--border-light)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                    {navBar}
                    {jobListView}
                  </div>
                  <div onMouseDown={onResizeHandleMouseDown} style={{ width: 9, backgroundColor: "transparent", marginLeft: -5, marginRight: -4, zIndex: 10, cursor: "col-resize", flexShrink: 0, position: "relative" }} />
                </>
              )}
              <div ref={split.detailPaneRef} className="detail-pane" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-secondary)", position: "relative" }}>
                {isEditorVisible ? (
                  <div style={panelContentStyle}>
                    {saveError && (
                      <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--danger-bg, #2d1b1b)", border: "1px solid var(--danger, #e55)", borderRadius: 4, fontSize: 13 }}>
                        Save failed: {saveError}
                      </div>
                    )}
                    <JobEditor
                      job={editingJob}
                      onSave={handleSave}
                      onCancel={() => {
                        if (editingJob) setViewingJob(editingJob);
                        setEditingJob(null); setIsCreating(false); setCreateForGroup(null); setSaveError(null);
                      }}
                      headerMode="close"
                      onPickTemplate={(templateId) => {
                        setIsCreating(false); setCreateForGroup(null);
                        setPickerTemplateId(templateId); setShowPicker(true);
                      }}
                      defaultGroup={createForGroup?.group}
                      defaultFolderPath={createForGroup?.folderPath ?? undefined}
                    />
                  </div>
                ) : isPickerVisible ? (
                  <div style={panelContentStyle}>
                    <SamplePicker
                      autoCreateTemplateId={pickerTemplateId ?? pendingTemplateId ?? undefined}
                      headerMode="close"
                      onCreated={() => {
                        setShowPicker(false); setPickerTemplateId(null);
                        onTemplateHandled?.(); core.reload();
                      }}
                      onBlank={() => {
                        setShowPicker(false); setPickerTemplateId(null);
                        onTemplateHandled?.(); setIsCreating(true);
                      }}
                      onCancel={() => {
                        setShowPicker(false); setPickerTemplateId(null);
                        onTemplateHandled?.();
                      }}
                    />
                  </div>
                ) : showFolderRunner ? (
                  detailPane
                ) : (
                  <SplitDetailArea
                    tree={split.tree}
                    renderLeaf={renderLeaf}
                    onRatioChange={split.handleSplitRatioChange}
                    onFocusLeaf={split.setFocusedLeafId}
                    focusedLeafId={split.focusedLeafId}
                    paneColors={split.paneColors}
                    minPaneSize={200}
                    emptyContent={detailPane}
                    overlay={dropOverlay}
                  />
                )}
                {rightPanelOverlay}
              </div>
              {dialogs}
            </div>
            <DragOverlay dropAnimation={null}>{dragOverlayContent}</DragOverlay>
          </DndContext>
        )}
      </div>
    </>
  );
}
