import { useCallback, useState } from "react";

import type { JobListViewProps } from "./sign";
import { useGroupAgentControls } from "./useGroupAgentControls";
import { useJobListDerivedItems } from "./useJobListDerivedItems";
import { useJobListRefs } from "./useJobListRefs";
import { useJobListSearch } from "./useJobListSearch";
import { useScrollEffects } from "./useScrollEffects";
import { useSelectableItems } from "./useSelectableItems";

export function useJobListView(props: JobListViewProps) {
  const [sortOpen, setSortOpen] = useState(false);
  const [collapsedJobPanes, setCollapsedJobPanes] = useState<Set<string>>(() => new Set());
  const [hiddenSectionCollapsed, setHiddenSectionCollapsed] = useState(true);
  const [groupMenu, setGroupMenu] = useState<{ group: string; folderPath?: string } | null>(null);
  const [groupMenuPos, setGroupMenuPos] = useState<{ top: number; left: number } | null>(null);

  const data = {
    detectedProcesses: props.detectedProcesses,
    jobs: props.jobs,
    shellPanes: props.shellPanes ?? [],
    statuses: props.statuses,
  };
  const ordering = {
    jobOrder: props.jobOrder ?? {},
    processOrder: props.processOrder ?? {},
    sortMode: props.sortMode ?? "name",
  };
  const grouping = {
    collapsedGroups: props.collapsedGroups,
    groupTabView: props.groupTabView,
    hiddenGroups: props.hiddenGroups,
    hiddenSectionCollapsed,
    pinnedItems: props.pinnedItems,
  };
  const agent = {
    agentModelOptions: props.agentModelOptions ?? [],
    defaultAgentModel: props.defaultAgentModel,
    defaultAgentProvider: props.defaultAgentProvider ?? "claude",
    getAgentProviders: props.getAgentProviders,
    onRunAgent: props.onRunAgent,
  };
  const callbacks = {
    onGroupTabViewChange: props.onGroupTabViewChange,
    onSelectableItemsChange: props.onSelectableItemsChange,
    onToggleGroup: props.onToggleGroup,
  };
  const scroll = {
    initialScrollOffset: props.initialScrollOffset,
    scrollToSlug: props.scrollToSlug,
  };

  const refs = useJobListRefs({ dragActive: props.dragActive, sidebarFocusRef: props.sidebarFocusRef });
  const search = useJobListSearch({
    refs: {
      containerRef: refs.containerRef,
      searchRef: refs.searchRef,
    },
    state: {
      controlledSearchQuery: props.searchQuery,
      onSearchQueryChange: props.onSearchQueryChange,
    },
  });
  const groupAgent = useGroupAgentControls({
    agent,
  });
  const derived = useJobListDerivedItems({
    agent,
    data,
    filters: { query: search.query },
    grouping,
    ordering,
  });
  useSelectableItems({
    callbacks,
    derived: {
      items: derived.items,
      matchedProcessesByJob: derived.matchedProcessesByJob,
    },
  });
  useScrollEffects({
    callbacks,
    data,
    grouping,
    refs: {
      scrollRef: refs.scrollRef,
    },
    scroll,
  });

  const handleRefresh = useCallback(() => {
    props.onRefresh?.();
  }, [props.onRefresh]);

  const toggleJobPanes = useCallback((slug: string) => {
    setCollapsedJobPanes((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  }, []);

  return {
    activeWorkspaceId: props.activeWorkspaceId,
    agentModelOptions: agent.agentModelOptions,
    autoYesPaneIds: props.autoYesPaneIds,
    collapsedGroups: grouping.collapsedGroups,
    collapsedJobPanes,
    containerRef: refs.containerRef,
    containerStyle: refs.containerStyle,
    containerWebProps: refs.containerWebProps,
    contentContainerStyle: props.contentContainerStyle,
    contentInsetAdjustmentBehavior: props.contentInsetAdjustmentBehavior,
    customRenderJobCard: props.renderJobCard,
    customRenderProcessCard: props.renderProcessCard,
    customRenderShellCard: props.renderShellCard,
    defaultAgentProvider: agent.defaultAgentProvider,
    detectedProcesses: data.detectedProcesses,
    dragActive: props.dragActive,
    emptyMessage: props.emptyMessage ?? "No jobs found.",
    focusAgentSignal: props.focusAgentSignal,
    focusAgentWorkDir: props.focusAgentWorkDir,
    focusedItemKey: props.focusedItemKey,
    groupAgent,
    groupMenu,
    groupMenuDropdownRef: refs.groupMenuDropdownRef,
    groupMenuPos,
    groupMenuTriggerRef: refs.groupMenuTriggerRef,
    groupMenuTriggerRefs: refs.groupMenuTriggerRefs,
    handleRefresh,
    headerContent: props.headerContent,
    hideSearchBar: props.hideSearchBar ?? false,
    hiddenSectionCollapsed,
    hoverSwitchTimerRef: refs.hoverSwitchTimerRef,
    items: derived.items,
    jobs: data.jobs,
    matchedProcessesByJob: derived.matchedProcessesByJob,
    onActivateWorkspace: props.onActivateWorkspace,
    onAddJob: props.onAddJob,
    onGroupTabViewChange: callbacks.onGroupTabViewChange,
    onHideGroup: props.onHideGroup,
    onProcessRenameDraftChange: props.onProcessRenameDraftChange,
    onProcessRenameStateChange: props.onProcessRenameStateChange,
    onRefresh: props.onRefresh,
    onRenameProcess: props.onRenameProcess,
    onRenameShell: props.onRenameShell,
    onRunAgent: agent.onRunAgent,
    onSaveProcessName: props.onSaveProcessName,
    onScrollOffsetChange: props.onScrollOffsetChange,
    onSelectJob: props.onSelectJob,
    onSelectProcess: props.onSelectProcess,
    onSelectShell: props.onSelectShell,
    onSetAllGroupTabView: props.onSetAllGroupTabView,
    onStopJob: props.onStopJob,
    onStopProcess: props.onStopProcess,
    onStopShell: props.onStopShell,
    onToggleGroup: callbacks.onToggleGroup,
    onTogglePin: props.onTogglePin,
    onUnhideGroup: props.onUnhideGroup,
    onSortChange: props.onSortChange,
    openElsewhereContentKeys: props.openElsewhereContentKeys,
    pinnedItems: props.pinnedItems,
    query: search.query,
    renameProcessPaneId: props.renameProcessPaneId,
    renameProcessSignal: props.renameProcessSignal,
    renameShortcutHint: props.renameShortcutHint ?? "Cmd+R",
    renderAsScrollRoot: props.renderAsScrollRoot ?? false,
    scrollEnabled: props.scrollEnabled ?? true,
    scrollEventThrottle: props.scrollEventThrottle ?? 100,
    scrollRef: refs.scrollRef,
    searchQuery: search.searchQuery,
    searchRef: refs.searchRef,
    selectedItems: props.selectedItems,
    selectedSlug: props.selectedSlug,
    setGroupMenu,
    setGroupMenuPos,
    setHiddenSectionCollapsed,
    setSearchQuery: search.setSearchQuery,
    setSortOpen,
    shellPanes: data.shellPanes,
    showEmpty: props.showEmpty ?? true,
    sortMode: ordering.sortMode,
    sortOpen,
    sortTriggerRef: refs.sortTriggerRef,
    statuses: data.statuses,
    stoppingSlugsExternal: props.stoppingSlugs,
    toggleJobPanes,
    wrapJobGroup: props.wrapJobGroup,
    wrapProcessGroup: props.wrapProcessGroup,
  };
}

export type JobListViewHook = ReturnType<typeof useJobListView>;
