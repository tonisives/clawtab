import { useCallback, useMemo } from "react";
import { Platform, Text, TextInput, TouchableOpacity, View } from "react-native";

import { colors } from "../../theme/colors";
import { SORT_OPTIONS } from "./sign";
import { styles } from "./styles";
import type { JobListViewHook } from "./useJobListView";
import { PopupMenu } from "../PopupMenu";
import { SegmentedControl } from "../SegmentedControl";

interface JobListToolbarProps {
  hook: JobListViewHook;
}

export function JobListToolbar({ hook }: JobListToolbarProps) {
  const globalTabsView = useMemo(() => {
    const groups: string[] = [];
    let totalTabs = 0;
    let totalJobs = 0;
    let allTabs = true;
    let allJobs = true;
    for (const item of hook.groupedItems) {
      if (item.kind !== "header" || !item.tabsToggle) continue;
      groups.push(item.tabsToggle.group);
      totalTabs += item.tabsToggle.tabCount;
      totalJobs += item.tabsToggle.jobCount;
      if (item.tabsToggle.view !== "tabs") allTabs = false;
      if (item.tabsToggle.view !== "jobs") allJobs = false;
    }
    const jobProcessPaneIds = new Set(
      [...hook.matchedProcessesByJob.values()].flatMap((processes) => (
        processes.map((process) => process.pane_id)
      )),
    );
    totalTabs = hook.detectedProcesses.filter((process) => !jobProcessPaneIds.has(process.pane_id)).length
      + hook.shellPanes.length;
    totalJobs = hook.jobs.length;
    return {
      groups,
      anyHeader: groups.length > 0 || totalTabs > 0,
      totalTabs,
      totalJobs,
      activeView: hook.listMode === "latest"
        ? ("latest" as const)
        : groups.length > 0 && allTabs
          ? ("tabs" as const)
          : groups.length > 0 && allJobs
            ? ("jobs" as const)
            : groups.length === 0 && totalTabs > 0
              ? ("tabs" as const)
              : null,
    };
  }, [hook.detectedProcesses, hook.groupedItems, hook.jobs.length, hook.listMode, hook.matchedProcessesByJob, hook.shellPanes.length]);

  const handleSelectSort = useCallback((mode: typeof hook.sortMode) => {
    hook.onSortChange?.(mode);
    hook.setSortOpen(false);
  }, [hook]);

  const handleClearSearch = useCallback(() => {
    hook.setSearchQuery("");
    (document.activeElement as HTMLElement)?.blur();
  }, [hook]);

  const handleSelectListMode = useCallback((mode: "tabs" | "latest" | "jobs") => {
    hook.onListModeChange?.(mode);
    if (mode !== "latest") {
      hook.onSetAllGroupTabView?.(globalTabsView.groups, mode);
    }
  }, [globalTabsView.groups, hook]);

  if (hook.compactMobileToolbar) {
    let compactViews = ["tabs", "jobs", "latest"] as const;
    return (
      <View style={styles.compactToolbarRow}>
        <SegmentedControl
          label="Sidebar view"
          value={hook.listMode}
          onChange={handleSelectListMode}
          stretch
          style={{ alignSelf: "stretch" }}
          options={compactViews.map((view) => ({ value: view, label: view === "tabs" ? "Tabs" : view === "jobs" ? "Jobs" : "Latest" }))}
        />
      </View>
    );
  }

  const sortableItemCount = hook.jobs.length + hook.detectedProcesses.length + hook.shellPanes.length;
  const shouldShowToolbar =
    (hook.onSortChange && sortableItemCount > 1) ||
    hook.jobs.length > 0 ||
    (hook.onListModeChange && (globalTabsView.anyHeader || hook.latestItemCount > 0));
  if (!shouldShowToolbar) return null;

  const currentSortLabel = SORT_OPTIONS.find((option) => option.value === hook.sortMode)?.label ?? "Name";

  return (
    <View style={[styles.sortRow, Platform.OS !== "web" ? styles.nativeToolbarRow : null]}>
      {!hook.hideSearchBar && (
        <View style={styles.searchBar}>
          <Text style={styles.searchIcon}>{"\u2315"}</Text>
          <TextInput
            ref={hook.searchRef}
            style={styles.searchInput}
            value={hook.searchQuery}
            onChangeText={hook.setSearchQuery}
            placeholder="Filter jobs..."
            placeholderTextColor={colors.textMuted}
            returnKeyType="done"
            inputAccessoryViewID={Platform.OS === "ios" ? "keyboard-dismiss" : undefined}
            onKeyPress={(event) => {
              if (event.nativeEvent.key === "Escape") {
                handleClearSearch();
              }
            }}
          />
          {hook.searchQuery.length > 0 && (
            <TouchableOpacity onPress={handleClearSearch} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.searchClear}>x</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {hook.onSortChange && sortableItemCount > 1 && (
        <View style={styles.sortControl}>
          <TouchableOpacity
            ref={hook.sortTriggerRef}
            onPress={() => hook.setSortOpen(!hook.sortOpen)}
            style={styles.sortTrigger}
            activeOpacity={0.6}
          >
            <Text style={styles.sortTriggerText}>{currentSortLabel}</Text>
            <Text style={styles.sortTriggerArrow}>{hook.sortOpen ? "\u25B4" : "\u25BE"}</Text>
          </TouchableOpacity>
          {hook.sortOpen && (
            <PopupMenu
              items={SORT_OPTIONS.map((option) => ({
                type: "item" as const,
                label: option.label,
                onPress: () => handleSelectSort(option.value),
                active: hook.sortMode === option.value,
              }))}
              triggerRef={hook.sortTriggerRef}
              onClose={() => hook.setSortOpen(false)}
            />
          )}
        </View>
      )}
      {hook.onListModeChange && (globalTabsView.anyHeader || hook.latestItemCount > 0) && (
        <>
          <View style={{ flexBasis: "100%", height: 0 }} />
          <SegmentedControl
            label="Sidebar view"
            value={globalTabsView.activeView}
            onChange={handleSelectListMode}
            compact
            style={Platform.OS !== "web" ? styles.nativeGlobalTabsSegment : undefined}
            options={(["tabs", "latest", "jobs"] as const).map((view) => {
              const count = view === "tabs" ? globalTabsView.totalTabs : view === "latest" ? hook.latestItemCount : globalTabsView.totalJobs;
              const label = view === "tabs" ? "Tabs" : view === "latest" ? "Latest" : "Jobs";
              return { value: view, label: `${label} (${count})` };
            })}
          />
        </>
      )}
    </View>
  );
}
