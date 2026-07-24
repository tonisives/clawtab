import { useCallback, useMemo } from "react";
import { Platform, Text, TextInput, TouchableOpacity, View } from "react-native";

import { colors } from "../../theme/colors";
import { SORT_OPTIONS } from "./sign";
import { styles } from "./styles";
import type { JobListViewHook } from "./useJobListView";
import { PopupMenu } from "../PopupMenu";

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
    for (const item of hook.items) {
      if (item.kind !== "header" || !item.tabsToggle) continue;
      groups.push(item.tabsToggle.group);
      totalTabs += item.tabsToggle.tabCount;
      totalJobs += item.tabsToggle.jobCount;
      if (item.tabsToggle.view !== "tabs") allTabs = false;
      if (item.tabsToggle.view !== "jobs") allJobs = false;
    }
    return {
      groups,
      anyHeader: groups.length > 0,
      totalTabs,
      totalJobs,
      activeView: groups.length > 0 && allTabs ? ("tabs" as const) : groups.length > 0 && allJobs ? ("jobs" as const) : null,
    };
  }, [hook.items]);

  const handleSelectSort = useCallback((mode: typeof hook.sortMode) => {
    hook.onSortChange?.(mode);
    hook.setSortOpen(false);
  }, [hook]);

  const handleClearSearch = useCallback(() => {
    hook.setSearchQuery("");
    (document.activeElement as HTMLElement)?.blur();
  }, [hook]);

  const sortableItemCount = hook.jobs.length + hook.detectedProcesses.length + hook.shellPanes.length;
  const shouldShowToolbar =
    (hook.onSortChange && sortableItemCount > 1) ||
    hook.jobs.length > 0 ||
    (hook.onSetAllGroupTabView && globalTabsView.anyHeader);
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
      {hook.onSetAllGroupTabView && globalTabsView.anyHeader && (
        <>
          <View style={{ flexBasis: "100%", height: 0 }} />
          <View
            style={[
              {
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 999,
                padding: Platform.OS === "web" ? 2 : 3,
              },
              Platform.OS !== "web" ? styles.nativeGlobalTabsSegment : null,
            ]}
          >
            {(["tabs", "jobs"] as const).map((view) => {
              const active = globalTabsView.activeView === view;
              const count = view === "tabs" ? globalTabsView.totalTabs : globalTabsView.totalJobs;
              const label = view === "tabs" ? "Tabs" : "Jobs";
              return (
                <TouchableOpacity
                  key={view}
                  onPress={() => hook.onSetAllGroupTabView?.(globalTabsView.groups, view)}
                  activeOpacity={0.7}
                  style={{
                    paddingHorizontal: Platform.OS === "web" ? 10 : 12,
                    paddingVertical: Platform.OS === "web" ? 2 : 7,
                    borderRadius: 999,
                    backgroundColor: active ? colors.accent : "transparent",
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: "600",
                      color: active ? "#ffffff" : colors.textSecondary,
                    }}
                  >
                    {label} ({count})
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      )}
    </View>
  );
}
