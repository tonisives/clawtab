import { useCallback, useState } from "react";

import type { JobListViewProps } from "./sign";
import { useGroupAgentControls } from "./useGroupAgentControls";
import { useJobListDerivedItems } from "./useJobListDerivedItems";
import { useJobListRefs } from "./useJobListRefs";
import { useJobListSearch } from "./useJobListSearch";
import { useScrollEffects } from "./useScrollEffects";
import { useSelectableItems } from "./useSelectableItems";

export function useJobListView({
  jobs,
  statuses,
  detectedProcesses,
  shellPanes = [],
  collapsedGroups,
  onToggleGroup,
  groupOrder: _groupOrder = [],
  jobOrder = {},
  processOrder = {},
  onRefresh,
  sortMode = "name",
  onSortChange,
  onSelectJob,
  onSelectProcess,
  onSelectShell,
  selectedItems,
  focusedItemKey,
  selectedSlug,
  onRunAgent,
  getAgentProviders,
  defaultAgentProvider = "claude",
  agentModelOptions = [],
  defaultAgentModel,
  onAddJob,
  hiddenGroups,
  onHideGroup,
  onUnhideGroup,
  headerContent,
  showEmpty = true,
  emptyMessage = "No jobs found.",
  contentContainerStyle,
  initialScrollOffset,
  onScrollOffsetChange,
  scrollToSlug,
  onStopJob,
  onStopProcess,
  onRenameProcess,
  onSaveProcessName,
  onStopShell,
  onRenameShell,
  autoYesPaneIds,
  renderJobCard: customRenderJobCard,
  renderProcessCard: customRenderProcessCard,
  renderShellCard: customRenderShellCard,
  wrapJobGroup,
  wrapProcessGroup,
  scrollEnabled = true,
  stoppingSlugs: stoppingSlugsExternal,
  onSelectableItemsChange,
  sidebarFocusRef,
  focusAgentWorkDir,
  focusAgentSignal,
  renameProcessPaneId,
  renameProcessSignal,
  onProcessRenameDraftChange,
  onProcessRenameStateChange,
  renameShortcutHint = "Cmd+R",
  activeWorkspaceId,
  onActivateWorkspace,
  dragActive,
  openElsewhereContentKeys,
  groupTabView,
  onGroupTabViewChange,
  onSetAllGroupTabView,
  searchQuery: controlledSearchQuery,
  onSearchQueryChange,
  hideSearchBar = false,
  scrollEventThrottle = 100,
  renderAsScrollRoot = false,
}: JobListViewProps) {
  const [sortOpen, setSortOpen] = useState(false);
  const [collapsedJobPanes, setCollapsedJobPanes] = useState<Set<string>>(() => new Set());
  const [hiddenSectionCollapsed, setHiddenSectionCollapsed] = useState(true);
  const [groupMenu, setGroupMenu] = useState<{ group: string; folderPath?: string } | null>(null);
  const [groupMenuPos, setGroupMenuPos] = useState<{ top: number; left: number } | null>(null);

  const refs = useJobListRefs({ dragActive, sidebarFocusRef });
  const search = useJobListSearch({
    containerRef: refs.containerRef,
    controlledSearchQuery,
    onSearchQueryChange,
    searchRef: refs.searchRef,
  });
  const groupAgent = useGroupAgentControls({
    agentModelOptions,
    defaultAgentModel,
    defaultAgentProvider,
    getAgentProviders,
  });
  const derived = useJobListDerivedItems({
    collapsedGroups,
    detectedProcesses,
    groupTabView,
    hiddenGroups,
    hiddenSectionCollapsed,
    jobOrder,
    jobs,
    onRunAgent,
    processOrder,
    query: search.query,
    shellPanes,
    sortMode,
    statuses,
  });
  useSelectableItems({
    items: derived.items,
    matchedProcessesByJob: derived.matchedProcessesByJob,
    onSelectableItemsChange,
  });
  useScrollEffects({
    collapsedGroups,
    detectedProcesses,
    groupTabView,
    initialScrollOffset,
    jobs,
    onGroupTabViewChange,
    onToggleGroup,
    scrollRef: refs.scrollRef,
    scrollToSlug,
    shellPanes,
  });

  const handleRefresh = useCallback(() => {
    onRefresh?.();
  }, [onRefresh]);

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
    activeWorkspaceId,
    agentModelOptions,
    autoYesPaneIds,
    collapsedGroups,
    collapsedJobPanes,
    containerRef: refs.containerRef,
    containerStyle: refs.containerStyle,
    containerWebProps: refs.containerWebProps,
    contentContainerStyle,
    customRenderJobCard,
    customRenderProcessCard,
    customRenderShellCard,
    defaultAgentProvider,
    detectedProcesses,
    dragActive,
    emptyMessage,
    focusAgentSignal,
    focusAgentWorkDir,
    focusedItemKey,
    groupAgent,
    groupMenu,
    groupMenuDropdownRef: refs.groupMenuDropdownRef,
    groupMenuPos,
    groupMenuTriggerRef: refs.groupMenuTriggerRef,
    groupMenuTriggerRefs: refs.groupMenuTriggerRefs,
    handleRefresh,
    headerContent,
    hideSearchBar,
    hiddenSectionCollapsed,
    hoverSwitchTimerRef: refs.hoverSwitchTimerRef,
    items: derived.items,
    jobs,
    matchedProcessesByJob: derived.matchedProcessesByJob,
    onActivateWorkspace,
    onAddJob,
    onGroupTabViewChange,
    onHideGroup,
    onProcessRenameDraftChange,
    onProcessRenameStateChange,
    onRefresh,
    onRenameProcess,
    onRenameShell,
    onRunAgent,
    onSaveProcessName,
    onScrollOffsetChange,
    onSelectJob,
    onSelectProcess,
    onSelectShell,
    onSetAllGroupTabView,
    onStopJob,
    onStopProcess,
    onStopShell,
    onToggleGroup,
    onUnhideGroup,
    onSortChange,
    openElsewhereContentKeys,
    query: search.query,
    renameProcessPaneId,
    renameProcessSignal,
    renameShortcutHint,
    renderAsScrollRoot,
    scrollEnabled,
    scrollEventThrottle,
    scrollRef: refs.scrollRef,
    searchQuery: search.searchQuery,
    searchRef: refs.searchRef,
    selectedItems,
    selectedSlug,
    setGroupMenu,
    setGroupMenuPos,
    setHiddenSectionCollapsed,
    setSearchQuery: search.setSearchQuery,
    setSortOpen,
    shellPanes,
    showEmpty,
    sortMode,
    sortOpen,
    sortTriggerRef: refs.sortTriggerRef,
    statuses,
    stoppingSlugsExternal,
    toggleJobPanes,
    wrapJobGroup,
    wrapProcessGroup,
  };
}

export type JobListViewHook = ReturnType<typeof useJobListView>;
