import { RefreshControl, ScrollView } from "react-native";

import { colors } from "../../theme/colors";
import { PopupMenu } from "../PopupMenu";
import { JobListItems } from "./ListItems";
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
      contentInsetAdjustmentBehavior="never"
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
      {hook.groupMenu && (hook.onAddJob || hook.onHideGroup) && (
        <PopupMenu
          items={[
            ...(hook.onAddJob ? [{ type: "item" as const, label: "Add Job", onPress: () => hook.onAddJob?.(hook.groupMenu!.group, hook.groupMenu!.folderPath) }] : []),
            ...(hook.onHideGroup ? [{ type: "item" as const, label: "Hide Group", onPress: () => hook.onHideGroup?.(hook.groupMenu!.group) }] : []),
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
