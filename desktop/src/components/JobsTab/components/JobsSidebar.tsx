import { useCallback, useMemo, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { DetectedProcess, JobStatus, ProcessProvider, RemoteJob, ShellPane, SidebarSelectableItem, Transport, useJobsCore, useSplitTree } from "@clawtab/shared";
import { JobListView, JobCard, RunningJobCard, ProcessCard, ShellCard, collectLeaves, leafContentKey, colors, spacing } from "@clawtab/shared";
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

type GroupedRowPosition = "single" | "first" | "middle" | "last";

function PinOverlay({ onUnpin }: { onUnpin: () => void }) {
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onUnpin();
      }}
      title="Unpin"
      style={{
        position: "absolute",
        top: 8,
        right: 28,
        width: 14,
        height: 14,
        borderRadius: 4,
        border: "none",
        background: "transparent",
        color: "var(--accent, #58a6ff)",
        padding: 0,
        cursor: "pointer",
        zIndex: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        userSelect: "none",
      }}
    >
      <svg
        width={10}
        height={10}
        viewBox="0 0 16 16"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: "block" }}
      >
        <path d="M10.5 1.5l4 4-2 1-3.5 3.5 1 3-2 1-3-3-3.5 3.5-1-1 3.5-3.5-3-3 1-2 3 1 3.5-3.5z" />
      </svg>
    </button>
  );
}

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
    () => buildModelOptions(["claude", "codex", "opencode", "antigravity", "shell"] as ProcessProvider[], enabledModels),
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
    // Optimistically update local shellPanes so the card moves immediately;
    // backend poll re-confirms within 5s.
    lifecycle.setShellPanes((prev) =>
      prev.map((p) => (p.pane_id === paneId ? { ...p, matched_group: groupKey } : p)),
    );
  }, [lifecycle.setShellPanes]);

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

  const pinnedSet = useMemo(() => new Set(settings.pinnedItems), [settings.pinnedItems]);
  const togglePin = settings.togglePin;

  const renderDraggableJobCard = useCallback(
    (props: { job: RemoteJob; group: string; indexInGroup: number; status: JobStatus; onPress?: () => void; selected?: string | boolean; softBorder?: boolean; onStop?: () => void; autoYesActive?: boolean; stopping?: boolean; marginTop?: number; dimmed?: boolean; dataJobSlug?: string; defaultAgentProvider?: ProcessProvider; groupedPosition?: GroupedRowPosition }) => {
      const pinKey = `job:${props.job.slug}`;
      return (
        <DraggableJobCard
          {...props}
          reorderEnabled={sortMode === "name"}
          defaultAgentProvider={defaultProvider}
          pinned={pinnedSet.has(pinKey)}
          onTogglePin={() => togglePin(pinKey)}
        />
      );
    },
    [sortMode, defaultProvider, pinnedSet, togglePin],
  );

  const renderDraggableProcessCard = useCallback(
    (props: { process: DetectedProcess; sortGroup: string; onPress?: () => void; inGroup?: boolean; selected?: string | boolean; softBorder?: boolean; onStop?: () => void; onRename?: () => void; onSaveName?: (name: string) => void; autoYesActive?: boolean; marginTop?: number; dataProcessId?: string; startRenameSignal?: number; onRenameDraftChange?: (value: string | null) => void; onRenameStateChange?: (editing: boolean) => void; renameShortcutHint?: string; groupedPosition?: GroupedRowPosition }) => {
      const target = moveToWorkspaceForCwd(props.process.cwd, props.process.matched_group);
      const pinKey = `process:${props.process.pane_id}`;
      return (
        <DraggableProcessCard
          {...props}
          reorderEnabled
          onMoveToWorkspace={target ? () => handleMoveProcessToWorkspace(props.process.pane_id, target.groupKey) : undefined}
          moveToWorkspaceLabel={target ? `Move to ${target.displayName}` : undefined}
          pinned={pinnedSet.has(pinKey)}
          onTogglePin={() => togglePin(pinKey)}
        />
      );
    },
    [moveToWorkspaceForCwd, handleMoveProcessToWorkspace, pinnedSet, togglePin],
  );

  const renderDraggableShellCard = useCallback(
    (props: { shell: ShellPane; onPress?: () => void; selected?: boolean | string; softBorder?: boolean; onStop?: () => void; onRename?: () => void; renameShortcutHint?: string; groupedPosition?: GroupedRowPosition }) => {
      const target = moveToWorkspaceForCwd(props.shell.cwd, props.shell.matched_group);
      const pinKey = `shell:${props.shell.pane_id}`;
      return (
        <DraggableShellCard
          {...props}
          onMoveToWorkspace={target ? () => handleMoveProcessToWorkspace(props.shell.pane_id, target.groupKey) : undefined}
          moveToWorkspaceLabel={target ? `Move to ${target.displayName}` : undefined}
          pinned={pinnedSet.has(pinKey)}
          onTogglePin={() => togglePin(pinKey)}
        />
      );
    },
    [moveToWorkspaceForCwd, handleMoveProcessToWorkspace, pinnedSet, togglePin],
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

  const pinnedHeader = useMemo(() => {
    if (settings.pinnedItems.length === 0) return null;
    const jobBySlug = new Map(core.jobs.map((j) => [j.slug, j as RemoteJob]));
    const procByPaneId = new Map(sidebarItems.detectedProcesses.map((p) => [p.pane_id, p]));
    const shellByPaneId = new Map(shellPanes.map((s) => [s.pane_id, s]));

    const rendered: ReactNode[] = [];
    for (const key of settings.pinnedItems) {
      const colonIdx = key.indexOf(":");
      if (colonIdx < 0) continue;
      const kind = key.slice(0, colonIdx);
      const id = key.slice(colonIdx + 1);

      if (kind === "job") {
        const job = jobBySlug.get(id);
        if (!job) continue;
        const status = core.statuses[id] ?? { state: "idle" as const };
        const rawColor = split.selectedItems?.get(id);
        const isFocused = !split.focusedItemKey || split.focusedItemKey === id;
        const selected: boolean | string = rawColor
          ? (isFocused ? rawColor : rawColor + "66")
          : false;
        const isStopping = stoppingJobSlugs.has(id);
        const onStop = status.state === "running" && !isStopping
          ? () => {
              setStoppingJobSlugs((prev) => new Set(prev).add(id));
              core.requestFastPoll(`job:${id}`);
              transport.stopJob(id).catch((err) => {
                setStoppingJobSlugs((prev) => {
                  const next = new Set(prev);
                  next.delete(id);
                  return next;
                });
                console.error(`Failed to stop job ${id}:`, err);
              });
            }
          : undefined;
        rendered.push(
          <div
            key={`pinned-${key}`}
            style={{ marginTop: rendered.length === 0 ? 0 : spacing.sm, position: "relative" }}
          >
            {status.state === "running" ? (
              <RunningJobCard
                job={job}
                status={status}
                onPress={() => onSelectJob(job)}
                selected={selected}
                onStop={onStop}
                autoYesActive={(status as any).pane_id ? autoYes.autoYesPaneIds?.has((status as any).pane_id) : false}
                stopping={isStopping}
                defaultAgentProvider={defaultProvider}
              />
            ) : (
              <JobCard
                job={job}
                status={status}
                onPress={() => onSelectJob(job)}
                selected={selected}
                defaultAgentProvider={defaultProvider}
              />
            )}
            <PinOverlay onUnpin={() => settings.togglePin(key)} />
          </div>,
        );
      } else if (kind === "process") {
        const proc = procByPaneId.get(id);
        if (!proc) continue;
        const rawColor = split.selectedItems?.get(id) ?? split.selectedItems?.get(`_term_${id}`);
        const isFocused = !split.focusedItemKey || split.focusedItemKey === id || split.focusedItemKey === `_term_${id}`;
        const selected: boolean | string = rawColor
          ? (isFocused ? rawColor : rawColor + "66")
          : false;
        rendered.push(
          <div
            key={`pinned-${key}`}
            style={{ marginTop: rendered.length === 0 ? 0 : spacing.sm, position: "relative" }}
          >
            <ProcessCard
              process={proc}
              onPress={() => onSelectProcess(proc)}
              selected={selected}
              autoYesActive={autoYes.autoYesPaneIds?.has(id) ?? false}
            />
            <PinOverlay onUnpin={() => settings.togglePin(key)} />
          </div>,
        );
      } else if (kind === "shell") {
        const shell = shellByPaneId.get(id);
        if (!shell) continue;
        const termKey = `_term_${id}`;
        const rawColor = split.selectedItems?.get(termKey);
        const isFocused = !split.focusedItemKey || split.focusedItemKey === termKey;
        const selected: boolean | string = rawColor
          ? (isFocused ? rawColor : rawColor + "66")
          : false;
        rendered.push(
          <div
            key={`pinned-${key}`}
            style={{ marginTop: rendered.length === 0 ? 0 : spacing.sm, position: "relative" }}
          >
            <ShellCard
              shell={shell}
              onPress={() => onSelectShell(shell)}
              selected={selected}
            />
            <PinOverlay onUnpin={() => settings.togglePin(key)} />
          </div>,
        );
      }
    }

    if (rendered.length === 0) return null;

    return (
      <div style={{ marginBottom: spacing.md, paddingBottom: spacing.sm, borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ color: colors.textSecondary, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, paddingTop: spacing.sm, paddingBottom: spacing.sm, paddingLeft: spacing.xs, paddingRight: spacing.xs }}>
          Pinned
        </div>
        {rendered}
      </div>
    );
  }, [settings, settings.pinnedItems, core.jobs, core.statuses, core.requestFastPoll, sidebarItems.detectedProcesses, shellPanes, split.selectedItems, split.focusedItemKey, stoppingJobSlugs, setStoppingJobSlugs, transport, onSelectJob, onSelectProcess, onSelectShell, autoYes.autoYesPaneIds, defaultProvider]);

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
      headerContent={pinnedHeader}
      showEmpty={core.loaded}
      emptyMessage="No jobs configured yet."
      scrollToSlug={viewing.scrollToSlug}
      scrollEnabled={!split.isDragging}
      onSelectableItemsChange={setSidebarSelectableItems}
      sidebarFocusRef={sidebarFocusRef}
      onStopJob={(slug) => {
        setStoppingJobSlugs((prev) => new Set(prev).add(slug));
        core.requestFastPoll(`job:${slug}`);
        transport.stopJob(slug).catch((err) => {
          setStoppingJobSlugs((prev) => {
            const next = new Set(prev);
            next.delete(slug);
            return next;
          });
          console.error(`Failed to stop job ${slug}:`, err);
        });
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
      groupTabView={settings.groupTabView}
      onGroupTabViewChange={settings.setGroupTabViewFor}
      onSetAllGroupTabView={settings.setAllGroupTabView}
    />
  );
}
