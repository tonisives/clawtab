import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from "@dnd-kit/core";
import type { RemoteJob } from "@clawtab/shared";
import type { DetectedProcess, ClaudeQuestion, ShellPane } from "@clawtab/shared";
import {
  NotificationSection,
  AutoYesBanner,
  DropZoneOverlay,
  useJobsCore,
  useJobActions,
  collectLeaves,
  shortenPath,
  type SidebarSelectableItem,
} from "@clawtab/shared";
import type { AutoYesEntry, PaneContent } from "@clawtab/shared";
import { createTauriTransport } from "../../transport/tauriTransport";
import type { Job } from "../../types";
import { DraggableNotificationCard, type DragData } from "../DraggableCards";
import { EmptyDetailAgent } from "../EmptyDetailAgent";
import { useQuestionPolling } from "../../hooks/useQuestionPolling";
import { useAutoYes } from "../../hooks/useAutoYes";
import { useImportJob } from "../../hooks/useImportJob";
import type { JobsTabProps } from "./types";
import { SINGLE_PANE_CACHE_LIMIT, paneContentCacheKey, shouldCacheSinglePaneContent } from "./utils";
import { useWindowSize } from "./hooks/useWindowSize";
import { useResizablePane } from "./hooks/useResizablePane";
import { useJobsTabSettings } from "./hooks/useJobsTabSettings";
import { Dialogs } from "./components/Dialogs";
import { DetailPane } from "./components/DetailPane";
import { DragOverlayContent } from "./components/DragOverlayContent";
import { JobsSidebar } from "./components/JobsSidebar";
import { JobEditorPane } from "./components/JobEditorPane";
import { JobsTabLayout } from "./components/JobsTabLayout";
import { SamplePickerPane } from "./components/SamplePickerPane";
import { useViewingState } from "./hooks/useViewingState";
import { useProcessLifecycle } from "./hooks/useProcessLifecycle";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { usePaneRenderers } from "./hooks/usePaneRenderers";
import { useProcessEditing } from "./hooks/useProcessEditing";
import { useSidebarItems } from "./hooks/useSidebarItems";
import { useJobsSplitTree } from "./hooks/useJobsSplitTree";
import { usePaneForking } from "./hooks/usePaneForking";
import { useActivePaneContext } from "./hooks/useActivePaneContext";
import { useAgentRunner } from "./hooks/useAgentRunner";
import { usePaneSelection } from "./hooks/usePaneSelection";

const transport = createTauriTransport();

export function JobsTab({ pendingTemplateId, onTemplateHandled, createJobKey, importCwtKey, pendingPaneId, onPaneHandled, navBar, rightPanelOverlay, onJobSelected }: JobsTabProps) {
  const core = useJobsCore(transport, 10000);
  const actions = useJobActions(transport, core.reloadStatuses);
  const settings = useJobsTabSettings();
  const { defaultProvider } = settings;

  // Viewing / navigation state (extracted hook)
  const viewing = useViewingState({ core, onJobSelected });
  const {
    viewingJob, setViewingJob, viewingProcess, setViewingProcess,
    viewingShell, viewingAgent,
    editingJob, setEditingJob, isCreating, setIsCreating,
    showPicker, setShowPicker, pickerTemplateId, setPickerTemplateId,
    saveError, setSaveError, createForGroup, setCreateForGroup,
    showFolderRunner,
    paramsDialog, setParamsDialog,
    focusEmptyAgentSignal,
    currentContent,
  } = viewing;
  const currentContentRef = useRef<PaneContent | null>(null);
  currentContentRef.current = currentContent;

  // Ref for shellPanes used by split tree callbacks (lifecycle hook populates it after split)
  const shellPanesRef = useRef<ShellPane[]>([]);
  const focusAgentSignal = 0;
  const renameProcessSignal = 0;

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

  const split = useJobsSplitTree({ core, viewing, shellPanesRef });

  // Process lifecycle (demotion, promotion, stopping)
  const lifecycle = useProcessLifecycle({ core, split, viewing });
  const {
    pendingAgentWorkDir,
    shellPanes,
  } = lifecycle;
  shellPanesRef.current = shellPanes;

  const processEditing = useProcessEditing({ core, viewing, lifecycle });
  const {
    processRenameDrafts,
    getProcessDisplayName,
    openRenameProcessDialog,
  } = processEditing;

  const sidebarItems = useSidebarItems({ core, settings, viewing, lifecycle });
  const { selectAdjacentItem, handleJobReorder, handleProcessReorder } = sidebarItems;

  const { handleSelectJob, handleSelectProcess, handleSelectShell } = usePaneSelection({ core, onJobSelected, split, viewing });

  const importJob = useImportJob(core.jobs as Job[], core.reload, importCwtKey);
  const { handleFork, handleForkWithSecrets, handleSplitPane } = usePaneForking({ core, split, lifecycle, viewing });

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

  // Resizable list pane
  const { listWidth, onResizeHandleMouseDown } = useResizablePane();

  // Responsive
  const { isWide } = useWindowSize();
  const [sidebarSelectableItems, setSidebarSelectableItems] = useState<SidebarSelectableItem[]>([]);
  const [recentSinglePaneContents, setRecentSinglePaneContents] = useState<PaneContent[]>([]);
  const sidebarFocusRef = useRef<{ focus: () => void } | null>(null);
  const { activePaneContent, activeProcessForRename, activeAgentWorkDir, getPaneIdForContent } = useActivePaneContext({ core, split, viewing, lifecycle });
  const keyboard = useKeyboardShortcuts({
    core, split, viewing, lifecycle, settings,
    transport,
    activePaneContent, activeProcessForRename,
    setEditProcessField: processEditing.setEditProcessField, openRenameProcessDialog,
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

  const agentRunner = useAgentRunner({
    actions,
    core,
    currentContentRef,
    defaultProvider,
    lifecycle,
    split,
    transport,
    viewing,
  });
  const { handleRunAgent, handleGetAgentProviders } = agentRunner;

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

  const detailPane = (
    <DetailPane
      showFolderRunner={showFolderRunner}
      currentContent={currentContent}
      recentSinglePaneContents={recentSinglePaneContents}
      renderSinglePaneContent={renderSinglePaneContent}
      folderRunnerPane={folderRunnerPane}
      viewing={viewing}
      autoYes={autoYes}
      handleRunWithParams={handleRunWithParams}
    />
  );

  const dialogs = (
    <Dialogs
      viewing={viewing}
      autoYes={autoYes}
      importJob={importJob}
      missedCronJobs={{
        names: missedCronJobs,
        runAll: handleRunMissedJobs,
        clear: () => setMissedCronJobs([]),
      }}
      paneDialogs={{
        skillSearchPaneId,
        setSkillSearchPaneId,
        injectSecretsPaneId,
        setInjectSecretsPaneId,
        onForkWithSecrets: handleForkWithSecrets,
        processEditing,
      }}
      handleRunWithParams={handleRunWithParams}
    />
  );

  const jobListView = (
    <JobsSidebar
      activeAgentWorkDir={activeAgentWorkDir}
      agentRunner={agentRunner}
      autoYes={autoYes}
      core={core}
      focusAgentSignal={focusAgentSignal}
      headerContent={notificationSection}
      isWide={isWide}
      lifecycle={lifecycle}
      onAddJob={handleAddJob}
      onSelectJob={handleSelectJob}
      onSelectProcess={handleSelectProcess}
      onSelectShell={handleSelectShell}
      processEditing={processEditing}
      renameProcessSignal={renameProcessSignal}
      setSidebarSelectableItems={setSidebarSelectableItems}
      settings={settings}
      sidebarFocusRef={sidebarFocusRef}
      sidebarItems={sidebarItems}
      split={split}
      transport={transport}
      viewing={viewing}
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

  const handleCancelEditor = () => {
    if (editingJob) setViewingJob(editingJob);
    setEditingJob(null);
    setIsCreating(false);
    setCreateForGroup(null);
    setSaveError(null);
  };

  const handlePickTemplate = (templateId: string) => {
    setIsCreating(false);
    setCreateForGroup(null);
    setPickerTemplateId(templateId);
    setShowPicker(true);
  };

  const handlePickerCreated = () => {
    setShowPicker(false);
    setPickerTemplateId(null);
    onTemplateHandled?.();
    core.reload();
  };

  const handlePickerBlank = () => {
    setShowPicker(false);
    setPickerTemplateId(null);
    onTemplateHandled?.();
    setIsCreating(true);
  };

  const handlePickerCancel = () => {
    setShowPicker(false);
    setPickerTemplateId(null);
    onTemplateHandled?.();
  };

  const editorPaneMobile = (
    <JobEditorPane
      createForGroup={createForGroup}
      editingJob={editingJob}
      headerMode="back"
      onCancel={handleCancelEditor}
      onPickTemplate={handlePickTemplate}
      onSave={handleSave}
      panelContentStyle={panelContentStyle}
      saveError={saveError}
    />
  );

  const editorPaneClose = (
    <JobEditorPane
      createForGroup={createForGroup}
      editingJob={editingJob}
      headerMode="close"
      onCancel={handleCancelEditor}
      onPickTemplate={handlePickTemplate}
      onSave={handleSave}
      panelContentStyle={panelContentStyle}
      saveError={saveError}
    />
  );

  const pickerPaneMobile = (
    <SamplePickerPane
      headerMode="back"
      onBlank={handlePickerBlank}
      onCancel={handlePickerCancel}
      onCreated={handlePickerCreated}
      panelContentStyle={panelContentStyle}
      pendingTemplateId={pendingTemplateId}
      pickerTemplateId={pickerTemplateId}
    />
  );

  const pickerPaneClose = (
    <SamplePickerPane
      headerMode="close"
      onBlank={handlePickerBlank}
      onCancel={handlePickerCancel}
      onCreated={handlePickerCreated}
      panelContentStyle={panelContentStyle}
      pendingTemplateId={pendingTemplateId}
      pickerTemplateId={pickerTemplateId}
    />
  );

  return (
    <JobsTabLayout
      detailPane={detailPane}
      dialogs={dialogs}
      dragOverlayContent={dragOverlayContent}
      dropOverlay={dropOverlay}
      editorPaneClose={editorPaneClose}
      editorPaneMobile={editorPaneMobile}
      isEditorVisible={isEditorVisible}
      isMainVisible={isMainVisible}
      isPickerVisible={isPickerVisible}
      isWide={isWide}
      jobListView={jobListView}
      listWidth={listWidth}
      mobileShowsDetail={!!(showFolderRunner || viewingAgent || pendingAgentWorkDir || viewingProcess || viewingShell || viewingJob)}
      navBar={navBar}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      onDragMove={handleDragMove}
      onDragStart={handleDragStart}
      onResizeHandleMouseDown={onResizeHandleMouseDown}
      pickerPaneClose={pickerPaneClose}
      pickerPaneMobile={pickerPaneMobile}
      renderLeaf={renderLeaf}
      rightPanelOverlay={rightPanelOverlay}
      showFolderRunner={showFolderRunner}
      sidebarCollapsed={sidebarCollapsed}
      split={split}
    />
  );
}
