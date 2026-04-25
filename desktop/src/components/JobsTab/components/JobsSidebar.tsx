import { useCallback, useMemo, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { DetectedProcess, JobStatus, ProcessProvider, RemoteJob, ShellPane, SidebarSelectableItem, Transport, useJobsCore, useSplitTree } from "@clawtab/shared";
import { JobListView, collectLeaves, leafContentKey } from "@clawtab/shared";
import { buildModelOptions } from "../../JobEditor/utils";
import { DraggableJobCard, DraggableProcessCard, DraggableShellCard } from "../../DraggableCards";
import type { useAutoYes } from "../../../hooks/useAutoYes";
import type { useAgentRunner } from "../hooks/useAgentRunner";
import type { useJobsTabSettings } from "../hooks/useJobsTabSettings";
import type { useProcessEditing } from "../hooks/useProcessEditing";
import type { useProcessLifecycle } from "../../../hooks/useProcessLifecycle";
import type { useSidebarItems } from "../hooks/useSidebarItems";
import type { useViewingState } from "../hooks/useViewingState";
import { formatShortcutSteps } from "../../../shortcuts";
import { useWorkspaceManager } from "../../../workspace/WorkspaceManager";

interface JobsSidebarProps {
  activeAgentWorkDir: string | null;
  agentRunner: ReturnType<typeof useAgentRunner>;
  autoYes: ReturnType<typeof useAutoYes>;
  core: ReturnType<typeof useJobsCore>;
  focusAgentSignal: number;
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
  const mgr = useWorkspaceManager();
  const { defaultProvider, defaultModel, enabledModels, groupOrder, hiddenGroups, jobOrder, processOrder, sortMode } = settings;
  const renameShortcutHint = useMemo(
    () => formatShortcutSteps(settings.shortcutSettings.rename_active_pane).map((step) => step.join("+")).join(" "),
    [settings.shortcutSettings.rename_active_pane],
  );

  const agentModelOptions = useMemo(
    () => buildModelOptions(["claude", "codex", "opencode", "shell"] as ProcessProvider[], enabledModels),
    [enabledModels],
  );

  const cwdToGroup = useMemo(() => {
    const map = new Map<string, { groupKey: string; displayName: string }>();
    for (const job of core.jobs) {
      const fp = job.folder_path ?? job.work_dir;
      if (!fp) continue;
      if (map.has(fp)) continue;
      const groupKey = job.group || "default";
      const displayName = groupKey === "default"
        ? (fp.split("/").filter(Boolean).pop() ?? "General")
        : groupKey;
      map.set(fp, { groupKey, displayName });
    }
    return map;
  }, [core.jobs]);

  const moveToWorkspaceForCwd = useCallback((cwd: string, currentGroup: string | null | undefined) => {
    const target = cwdToGroup.get(cwd);
    if (!target) return null;
    if ((currentGroup ?? null) === target.groupKey) return null;
    return target;
  }, [cwdToGroup]);

  const handleMoveProcessToWorkspace = useCallback((paneId: string, groupKey: string) => {
    invoke("set_detected_process_group", { paneId, group: groupKey }).catch(() => {});
  }, []);

  const openElsewhereContentKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [wsId, state] of mgr.getAllStates()) {
      if (wsId === mgr.activeId) continue;
      if (state.tree) {
        for (const leaf of collectLeaves(state.tree)) {
          keys.add(leafContentKey(leaf.content));
        }
      }
      if (state.singlePaneContent) {
        keys.add(leafContentKey(state.singlePaneContent));
      }
    }
    return keys;
  }, [mgr]);
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
    (props: { job: RemoteJob; group: string; indexInGroup: number; status: JobStatus; onPress?: () => void; selected?: string | boolean; softBorder?: boolean; onStop?: () => void; autoYesActive?: boolean; stopping?: boolean; marginTop?: number; dimmed?: boolean; dataJobSlug?: string; defaultAgentProvider?: ProcessProvider }) => (
      <DraggableJobCard
        {...props}
        reorderEnabled={sortMode === "name"}
        defaultAgentProvider={defaultProvider}
      />
    ),
    [sortMode, defaultProvider],
  );

  const renderDraggableProcessCard = useCallback(
    (props: { process: DetectedProcess; sortGroup: string; onPress?: () => void; inGroup?: boolean; selected?: string | boolean; softBorder?: boolean; onStop?: () => void; onRename?: () => void; onSaveName?: (name: string) => void; autoYesActive?: boolean; marginTop?: number; dataProcessId?: string; startRenameSignal?: number; onRenameDraftChange?: (value: string | null) => void; onRenameStateChange?: (editing: boolean) => void; renameShortcutHint?: string }) => {
      const target = moveToWorkspaceForCwd(props.process.cwd, props.process.matched_group);
      return (
        <DraggableProcessCard
          {...props}
          reorderEnabled
          onMoveToWorkspace={target ? () => handleMoveProcessToWorkspace(props.process.pane_id, target.groupKey) : undefined}
          moveToWorkspaceLabel={target ? `Move to ${target.displayName}` : undefined}
        />
      );
    },
    [moveToWorkspaceForCwd, handleMoveProcessToWorkspace],
  );

  const renderDraggableShellCard = useCallback(
    (props: { shell: ShellPane; onPress?: () => void; selected?: boolean | string; softBorder?: boolean; onStop?: () => void; onRename?: () => void; renameShortcutHint?: string }) => {
      const target = moveToWorkspaceForCwd(props.shell.cwd, props.shell.matched_group);
      return (
        <DraggableShellCard
          {...props}
          onMoveToWorkspace={target ? () => handleMoveProcessToWorkspace(props.shell.pane_id, target.groupKey) : undefined}
          moveToWorkspaceLabel={target ? `Move to ${target.displayName}` : undefined}
        />
      );
    },
    [moveToWorkspaceForCwd, handleMoveProcessToWorkspace],
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

  const handleRunAgent = useCallback(
    (prompt: string, workDir?: string, provider?: ProcessProvider, model?: string | null) =>
      agentRunner.handleRunAgent(prompt, workDir, provider, model ?? undefined),
    [agentRunner],
  );

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
      onRunAgent={handleRunAgent}
      getAgentProviders={agentRunner.handleGetAgentProviders}
      defaultAgentProvider={defaultProvider}
      agentModelOptions={agentModelOptions}
      defaultAgentModel={defaultModel}
      onAddJob={onAddJob}
      hiddenGroups={hiddenGroups}
      onHideGroup={settings.handleHideGroup}
      onUnhideGroup={settings.handleUnhideGroup}
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
      renameShortcutHint={renameShortcutHint}
      autoYesPaneIds={autoYes.autoYesPaneIds}
      renderJobCard={isWide ? renderDraggableJobCard : undefined}
      renderProcessCard={isWide ? renderDraggableProcessCard : undefined}
      renderShellCard={isWide ? renderDraggableShellCard : undefined}
      wrapJobGroup={isWide && sortMode === "name" ? wrapSortableJobGroup : undefined}
      wrapProcessGroup={isWide ? wrapSortableProcessGroup : undefined}
      stoppingSlugs={stoppingJobSlugs}
      activeWorkspaceId={mgr.activeId}
      onActivateWorkspace={(group) => {
        mgr.ensure(group);
        mgr.setActive(group);
      }}
      dragActive={split.isDragging}
      openElsewhereContentKeys={openElsewhereContentKeys}
    />
  );
}
