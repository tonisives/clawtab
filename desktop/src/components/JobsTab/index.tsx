import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import type { RemoteJob } from "@clawtab/shared";
import type { ShellPane } from "@clawtab/shared";
import {
  DropZoneOverlay,
  useJobsCore,
  useJobActions,
  type SidebarSelectableItem,
} from "@clawtab/shared";
import type { PaneContent, SplitNode } from "@clawtab/shared";
import { createTauriTransport } from "../../transport/tauriTransport";
import type { Job } from "../../types";
import type { DragData } from "../DraggableCards";
import { EmptyDetailAgent } from "../EmptyDetailAgent";
import { useImportJob } from "../../hooks/useImportJob";
import type { JobsTabProps } from "./types";
import { useWindowSize } from "./hooks/useWindowSize";
import { useResizablePane } from "./hooks/useResizablePane";
import { useJobsTabSettings } from "./hooks/useJobsTabSettings";
import { Dialogs } from "./components/Dialogs";
import { DetailPane } from "./components/DetailPane";
import { DragOverlayContent } from "./components/DragOverlayContent";
import { JobsSidebar } from "./components/JobsSidebar";
import { JobEditorPane } from "./components/JobEditorPane";
import { JobsTabLayout } from "./components/JobsTabLayout";
import { NotificationsMenuButton } from "./components/NotificationsMenuButton";
import { SamplePickerPane } from "./components/SamplePickerPane";
import { useViewingState } from "./hooks/useViewingState";
import { useProcessLifecycle } from "../../hooks/useProcessLifecycle";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { usePaneRenderers } from "./hooks/usePaneRenderers";
import { useProcessEditing } from "./hooks/useProcessEditing";
import { useSidebarItems } from "./hooks/useSidebarItems";
import { useJobsSplitTree } from "./hooks/useJobsSplitTree";
import { usePaneForking } from "./hooks/usePaneForking";
import { useActivePaneContext } from "./hooks/useActivePaneContext";
import { useAgentRunner } from "./hooks/useAgentRunner";
import { usePaneSelection } from "./hooks/usePaneSelection";
import { useJobsTabHandlers } from "./hooks/useJobsTabHandlers";
import { useFolderRunGroups } from "./hooks/useFolderRunGroups";
import { useJobsNotifications } from "./hooks/useJobsNotifications";
import { useJobsTabEffects } from "./hooks/useJobsTabEffects";
import { formatShortcutSteps } from "../../shortcuts";

const transport = createTauriTransport();

function findTopLeftLeafId(tree: SplitNode | null): string | null {
  let node = tree;
  while (node && node.type === "split") node = node.first;
  return node?.type === "leaf" ? node.id : null;
}

export function JobsTab({ pendingTemplateId, onTemplateHandled, createJobKey, importCwtKey, pendingPaneId, onPaneHandled, navBar, rightPanelOverlay, onJobSelected }: JobsTabProps) {
  const core = useJobsCore(transport, 10000);
  const actions = useJobActions(transport, core.reloadStatuses);
  const settings = useJobsTabSettings();
  const { defaultProvider, defaultModel, enabledModels } = settings;

  // Viewing / navigation state (extracted hook)
  const viewing = useViewingState({ core, onJobSelected });
  const {
    viewingJob, viewingProcess,
    viewingShell, viewingAgent,
    editingJob, setEditingJob, isCreating,
    showPicker, pickerTemplateId,
    saveError, createForGroup,
    showFolderRunner,
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

  const split = useJobsSplitTree({ core, viewing, shellPanesRef });

  // Process lifecycle (demotion, promotion, stopping, question polling, auto-yes)
  const lifecycle = useProcessLifecycle({ core, split, viewing });
  const {
    pendingAgentWorkDir,
    shellPanes,
    questionPolling,
    autoYes,
  } = lifecycle;
  shellPanesRef.current = shellPanes;
  const { questions } = questionPolling;

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

  // Resizable list pane
  const { listWidth, onResizeHandleMouseDown } = useResizablePane();

  // Responsive
  const { isWide } = useWindowSize();
  const [sidebarSelectableItems, setSidebarSelectableItems] = useState<SidebarSelectableItem[]>([]);
  const sidebarFocusRef = useRef<{ focus: () => void } | null>(null);
  const { activePaneContent, activeProcessForRename, activeAgentWorkDir, getPaneIdForContent } = useActivePaneContext({ core, split, viewing, lifecycle });

  const toggleActiveAutoYes = useCallback(() => {
    const paneId = getPaneIdForContent(activePaneContent);
    if (!paneId) return;
    const question = questions.find((q) => q.pane_id === paneId);
    if (question) {
      autoYes.handleToggleAutoYes(question);
    } else {
      const proc = core.processes.find((p) => p.pane_id === paneId);
      const title = proc?.display_name ?? proc?.cwd.replace(/^\/Users\/[^/]+/, "~") ?? paneId;
      autoYes.handleToggleAutoYesByPaneId(paneId, title);
    }
  }, [activePaneContent, autoYes, core.processes, getPaneIdForContent, questions]);

  const keyboard = useKeyboardShortcuts({
    core, split, viewing, lifecycle, settings,
    transport,
    activePaneContent, activeProcessForRename,
    setEditProcessField: processEditing.setEditProcessField, openRenameProcessDialog,
    handleSplitPane, getPaneIdForContent,
    handleSelectJob, handleSelectProcess, handleSelectShell,
    sidebarSelectableItems, sidebarFocusRef,
    toggleActiveAutoYes,
  });
  const { sidebarCollapsed } = keyboard;

  const isFullScreenView = !isWide && !!(editingJob || isCreating || showPicker);
  const trafficLightInset = isWide && sidebarCollapsed ? 84 : 0;
  const topLeftLeafId = useMemo(() => findTopLeftLeafId(split.tree), [split.tree]);
  const { recentSinglePaneContents } = useJobsTabEffects({
    core,
    createJobKey,
    isFullScreenView,
    isWide,
    onPaneHandled,
    pendingPaneId,
    pendingTemplateId,
    shellPanes,
    setMissedCronJobs,
    split,
    viewing,
  });

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

  const handlers = useJobsTabHandlers({
    actions,
    autoYes,
    core,
    handleJobReorder,
    handleProcessReorder,
    handleSplitPane,
    missedCronJobs,
    onTemplateHandled,
    questionPolling,
    setMissedCronJobs,
    split,
    viewing,
  });
  const {
    buildJobPaneActions,
    buildJobTitlePath,
    buildProcessTitlePath,
    handleAddJob,
    handleAutoYesPress,
    handleCancelEditor,
    handleDragCancel,
    handleDragEnd,
    handleDragMove,
    handleDragStart,
    handleDuplicate,
    handleDuplicateToFolder,
    handleOpen,
    handlePickTemplate,
    handlePickerBlank,
    handlePickerCancel,
    handlePickerCreated,
    handleQuestionNavigate,
    handleRunMissedJobs,
    handleRunWithParams,
    handleSave,
  } = handlers;

  const folderRunGroups = useFolderRunGroups(core);

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

  const autoYesShortcut = formatShortcutSteps(settings.shortcutSettings.toggle_auto_yes).map((s) => s.join("+")).join(" ");

  const { renderLeaf, renderSinglePaneContent } = usePaneRenderers({
    core, split, viewing, lifecycle, actions,
    questions, questionPolling, autoYes, transport,
    agentJob, agentProcess,
    isWide, trafficLightInsetStyle, defaultProvider, defaultModel, enabledModels,
    autoYesShortcut,
    sidebarFocusRef,
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

  const notificationMenuContent = useJobsNotifications({
    autoYes,
    core,
    handleAutoYesPress,
    handleQuestionNavigate,
    isWide,
    questionPolling,
    questions,
  });
  const notificationButton = (
    <NotificationsMenuButton
      activeQuestionCount={questions.length}
      hasAutoYesEntries={autoYes.autoYesEntries.length > 0}
    >
      {notificationMenuContent}
    </NotificationsMenuButton>
  );
  const resolvedNavBar = typeof navBar === "function" ? navBar(notificationButton) : navBar;

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
      defaultModel={defaultModel}
      enabledModels={enabledModels}
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
      folderRunnerPane={folderRunnerPane}
      isEditorVisible={isEditorVisible}
      isMainVisible={isMainVisible}
      isPickerVisible={isPickerVisible}
      isWide={isWide}
      jobListView={jobListView}
      listWidth={listWidth}
      mobileShowsDetail={!!(showFolderRunner || viewingAgent || pendingAgentWorkDir || viewingProcess || viewingShell || viewingJob)}
      navBar={resolvedNavBar}
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
