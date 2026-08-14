import { RefreshControl, ScrollView } from "react-native";

import { colors } from "../../theme/colors";
import { PopupMenu } from "../PopupMenu";
import { JobListItems } from "./ListItems";
import { LATEST_SORT_OPTIONS } from "./sign";
import { styles } from "./styles";
import { JobListToolbar } from "./Toolbar";
import type { JobListViewHook } from "./useJobListView";

interface JobListScrollContentProps {
  hook: JobListViewHook;
}

export function JobListScrollContent({ hook }: JobListScrollContentProps) {
  return (
    <ScrollView
      ref={hook.scrollRef}
      style={styles.scroll}
      contentContainerStyle={[styles.list, hook.contentContainerStyle]}
      scrollEnabled={hook.scrollEnabled}
      contentInsetAdjustmentBehavior={hook.contentInsetAdjustmentBehavior ?? "never"}
      automaticallyAdjustKeyboardInsets
      alwaysBounceHorizontal={false}
      alwaysBounceVertical
      bounces
      directionalLockEnabled
      horizontal={false}
      onScroll={(event) => { hook.onScrollOffsetChange?.(event.nativeEvent.contentOffset.y); }}
      scrollEventThrottle={hook.scrollEventThrottle}
      refreshControl={
        hook.onRefresh ? (
          <RefreshControl
            refreshing={false}
            onRefresh={hook.handleRefresh}
            tintColor={colors.accent}
          />
        ) : undefined
      }
    >
      {hook.headerContent}
      <JobListToolbar hook={hook} />
      <JobListItems hook={hook} />
      {hook.groupMenu && (hook.onAddJob || hook.onGroupLatestSortChange || hook.onHideGroup || hook.onUnhideGroup) && (
        <PopupMenu
          items={[
            ...(hook.onGroupLatestSortChange ? [{
              type: "submenu" as const,
              label: "Sort by",
              items: LATEST_SORT_OPTIONS.map((option) => ({
                type: "item" as const,
                label: option.label,
                active: hook.groupLatestSortMode?.[hook.groupMenu!.sortGroup] === option.value,
                onPress: () => {
                  hook.onGroupLatestSortChange?.(hook.groupMenu!.sortGroup, option.value);
                  hook.setGroupMenu(null);
                },
              })),
            }] : []),
            ...(hook.onGroupLatestSortChange && (hook.onAddJob || hook.onHideGroup || hook.onUnhideGroup)
              ? [{ type: "separator" as const }]
              : []),
            ...(hook.onAddJob ? [{ type: "item" as const, label: "Add Job", onPress: () => hook.onAddJob?.(hook.groupMenu!.group, hook.groupMenu!.folderPath) }] : []),
            ...(hook.groupMenu.hidden && hook.onUnhideGroup ? [{ type: "item" as const, label: "Show Group", onPress: () => hook.onUnhideGroup?.(hook.groupMenu!.group) }] : []),
            ...(!hook.groupMenu.hidden && hook.onHideGroup ? [{ type: "item" as const, label: "Hide Group", onPress: () => hook.onHideGroup?.(hook.groupMenu!.group) }] : []),
          ]}
          position={hook.groupMenuPos}
          dropdownRef={hook.groupMenuDropdownRef}
          triggerRef={hook.groupMenuTriggerRef}
          onClose={() => hook.setGroupMenu(null)}
        />
      )}
    </ScrollView>
  );
}
