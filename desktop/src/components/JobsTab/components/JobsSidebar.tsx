import { useCallback, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { DetectedProcess, JobStatus, ProcessProvider, RemoteJob, ShellPane, SidebarSelectableItem, Transport, useJobsCore, useSplitTree } from "@clawtab/shared";
import { JobListView } from "@clawtab/shared";
import { DraggableJobCard, DraggableProcessCard, DraggableShellCard } from "../../DraggableCards";
import type { useAutoYes } from "../../../hooks/useAutoYes";
import type { useAgentRunner } from "../hooks/useAgentRunner";
import type { useJobsTabSettings } from "../hooks/useJobsTabSettings";
import type { useProcessEditing } from "../hooks/useProcessEditing";
import type { useProcessLifecycle } from "../hooks/useProcessLifecycle";
import type { useSidebarItems } from "../hooks/useSidebarItems";
import type { useViewingState } from "../hooks/useViewingState";

interface JobsSidebarProps {
  activeAgentWorkDir: string | null;
  agentRunner: ReturnType<typeof useAgentRunner>;
  autoYes: ReturnType<typeof useAutoYes>;
  core: ReturnType<typeof useJobsCore>;
  focusAgentSignal: number;
  headerContent: ReactNode;
  isWide: boolean;
  lifecycle: ReturnType<typeof useProcessLifecycle>;
  onAddJob: (group: string, folderPath?: string) => void;
  onSelectJob: (job: RemoteJob) => void;
  onSelectProcess: (process: DetectedProcess) => void;
  onSelectShell: (shell: ShellPane) => void;
  processEditing: ReturnType<typeof useProcessEditing>;
  renameProcessSignal: number;
  setSidebarSelectableItems: (items: SidebarSelectableItem[]) => void;
  settings: ReturnType<typeof useJobsTabSettings>;
  sidebarFocusRef: RefObject<{ focus: () => void } | null>;
  sidebarItems: ReturnType<typeof useSidebarItems>;
  split: ReturnType<typeof useSplitTree>;
  transport: Transport;
  viewing: ReturnType<typeof useViewingState>;
}

export function JobsSidebar({
  activeAgentWorkDir,
  agentRunner,
  autoYes,
  core,
  focusAgentSignal,
  headerContent,
  isWide,
  lifecycle,
  onAddJob,
  onSelectJob,
  onSelectProcess,
  onSelectShell,
  processEditing,
  renameProcessSignal,
  setSidebarSelectableItems,
  settings,
  sidebarFocusRef,
  sidebarItems,
  split,
  transport,
  viewing,
}: JobsSidebarProps) {
  const { defaultProvider, groupOrder, hiddenGroups, jobOrder, processOrder, sortMode } = settings;
  const {
    demotedShellPaneIdsRef,
    setShellPanes,
    setStoppingJobSlugs,
    setStoppingProcesses,
    shellPanes,
    stoppingJobSlugs,
  } = lifecycle;
  const {
    handleProcessRenameDraftChange,
    handleProcessRenameStateChange,
    handleSaveProcessNameInline,
    openRenameProcessDialog,
    openRenameShellDialog,
    renameProcessPaneId,
  } = processEditing;

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

  const wrapSortableJobGroup = useCallback((group: string, jobSlugs: string[], children: ReactNode) => (
    <SortableContext
      key={`sortable-${group}`}
      items={jobSlugs}
      strategy={verticalListSortingStrategy}
    >
      {children}
    </SortableContext>
  ), []);

  const wrapSortableProcessGroup = useCallback((group: string, processPaneIds: string[], children: ReactNode) => (
    <SortableContext
      key={`sortable-process-${group}`}
      items={processPaneIds}
      strategy={verticalListSortingStrategy}
    >
      {children}
    </SortableContext>
  ), []);

  return (
    <JobListView
      jobs={core.jobs}
      statuses={core.statuses}
      detectedProcesses={sidebarItems.detectedProcesses}
      shellPanes={shellPanes}
      collapsedGroups={core.collapsedGroups}
      onToggleGroup={core.toggleGroup}
      groupOrder={groupOrder}
      jobOrder={jobOrder}
      processOrder={processOrder}
      sortMode={sortMode}
      onSortChange={settings.setSortMode}
      onSelectJob={onSelectJob}
      onSelectProcess={onSelectProcess}
      onSelectShell={onSelectShell}
      selectedItems={split.selectedItems}
      focusedItemKey={split.focusedItemKey}
      onRunAgent={agentRunner.handleRunAgent}
      getAgentProviders={agentRunner.handleGetAgentProviders}
      defaultAgentProvider={defaultProvider}
      onAddJob={onAddJob}
      hiddenGroups={hiddenGroups}
      onHideGroup={settings.handleHideGroup}
      onUnhideGroup={settings.handleUnhideGroup}
      headerContent={headerContent}
      showEmpty={core.loaded}
      emptyMessage="No jobs configured yet."
      scrollToSlug={viewing.scrollToSlug}
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
      onProcessRenameDraftChange={handleProcessRenameDraftChange}
      onProcessRenameStateChange={handleProcessRenameStateChange}
      onStopShell={(paneId) => {
        demotedShellPaneIdsRef.current.delete(paneId);
        setShellPanes((prev) => prev.filter((p) => p.pane_id !== paneId));
        if (viewing.viewingShell?.pane_id === paneId) sidebarItems.selectAdjacentItem(paneId);
        invoke("stop_detected_process", { paneId });
      }}
      onRenameShell={openRenameShellDialog}
      autoYesPaneIds={autoYes.autoYesPaneIds}
      renderJobCard={isWide ? renderDraggableJobCard : undefined}
      renderProcessCard={isWide ? renderDraggableProcessCard : undefined}
      renderShellCard={isWide ? renderDraggableShellCard : undefined}
      wrapJobGroup={isWide && sortMode === "name" ? wrapSortableJobGroup : undefined}
      wrapProcessGroup={isWide ? wrapSortableProcessGroup : undefined}
      stoppingSlugs={stoppingJobSlugs}
    />
  );
}
