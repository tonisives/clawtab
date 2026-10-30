import { Platform, Text, TouchableOpacity, View } from "react-native";

import { colors } from "../../theme/colors";
import { SegmentedControl } from "../SegmentedControl";
import { spacing } from "../../theme/spacing";
import type { ListItem } from "./sign";
import { styles } from "./styles";
import type { JobListViewHook } from "./useJobListView";

interface JobListHeaderItemProps {
  hook: JobListViewHook;
  item: Extract<ListItem, { kind: "header" }>;
  itemKey: string;
  index: number;
  prevWasActive: boolean;
}

export function JobListHeaderItem({ hook, item, itemKey, index, prevWasActive }: JobListHeaderItemProps) {
  const isCollapsed = !hook.query && hook.collapsedGroups.has(item.group);
  const allowGroupMenu = item.group !== "Shells" && (
    (!item.agentOnly && hook.onAddJob) || hook.onGroupLatestSortChange || (item.hidden ? hook.onUnhideGroup : hook.onHideGroup)
  );
  const isWorkspaceHeader = hook.activeWorkspaceId != null && item.group !== "Shells";
  const isActiveWorkspace = isWorkspaceHeader && item.group === hook.activeWorkspaceId;
  const isInactiveWorkspace = isWorkspaceHeader && !isActiveWorkspace;
  const hoverSwitchHandlers = hook.dragActive && isInactiveWorkspace && hook.onActivateWorkspace
    ? {
      onMouseEnter: () => {
        if (hook.hoverSwitchTimerRef.current) clearTimeout(hook.hoverSwitchTimerRef.current);
        const group = item.group;
        hook.hoverSwitchTimerRef.current = setTimeout(() => {
          hook.onActivateWorkspace?.(group);
          hook.hoverSwitchTimerRef.current = null;
        }, 250) as unknown as number;
      },
      onMouseLeave: () => {
        if (hook.hoverSwitchTimerRef.current) {
          clearTimeout(hook.hoverSwitchTimerRef.current);
          hook.hoverSwitchTimerRef.current = null;
        }
      },
    }
    : undefined;
  const headerMarginTop = isActiveWorkspace
    ? 0
    : index === 0
      ? 0
      : prevWasActive
        ? spacing.sm / 2
        : spacing.sm;
  const menuButton = allowGroupMenu ? (
    <TouchableOpacity
      ref={(ref: any) => {
        if (ref) hook.groupMenuTriggerRefs.current[item.group] = ref;
        else delete hook.groupMenuTriggerRefs.current[item.group];
        if (hook.groupMenu?.group === item.group) hook.groupMenuTriggerRef.current = ref;
      }}
      onPress={(event: any) => {
        event.stopPropagation();
        if (hook.groupMenu?.group === item.group) {
          hook.setGroupMenu(null);
          return;
        }
        hook.groupMenuTriggerRef.current = hook.groupMenuTriggerRefs.current[item.group] ?? event?.currentTarget ?? event?.target ?? null;
        hook.setGroupMenuPos(null);
        if (Platform.OS === "web") {
          const node = event?.currentTarget ?? event?.target;
          hook.groupMenuTriggerRef.current = node;
          if (node?.getBoundingClientRect) {
            const rect = node.getBoundingClientRect();
            hook.setGroupMenuPos({ top: rect.bottom + 4, left: rect.right });
          }
        }
        hook.setGroupMenu({
          group: item.group,
          sortGroup: item.tabsToggle?.group ?? item.group,
          folderPath: item.folderPath,
          hidden: item.hidden,
          agentOnly: item.agentOnly,
        });
      }}
      style={styles.addJobBtn}
      activeOpacity={0.6}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <View style={styles.addJobBtnDots} pointerEvents="none">
        <View style={styles.addJobBtnDot} />
        <View style={styles.addJobBtnDot} />
        <View style={styles.addJobBtnDot} />
      </View>
    </TouchableOpacity>
  ) : null;

  return (
    <View
      key={itemKey}
      style={[
        headerMarginTop ? { marginTop: headerMarginTop } : null,
        hook.mobileAppearance ? styles.nativeGroupHeaderWrap : null,
        hook.edgeToEdge && { marginHorizontal: 0 },
      ]}
      {...(hoverSwitchHandlers ?? {})}
    >
      <TouchableOpacity
        onPress={() => {
          if (hook.onActivateWorkspace && isWorkspaceHeader) {
            hook.onActivateWorkspace(item.group);
            return;
          }
          hook.onToggleGroup(item.group);
        }}
        style={[styles.groupHeaderRow, isActiveWorkspace ? styles.activeWorkspaceHeaderRow : null]}
        activeOpacity={0.6}
      >
        <View style={styles.groupHeaderTitleArea}>
          <TouchableOpacity
            onPress={(event: any) => {
              event?.stopPropagation?.();
              hook.onToggleGroup(item.group);
            }}
            style={styles.groupHeaderArrowBtn}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.groupHeaderArrow}>
              {isCollapsed ? "\u25B6" : "\u25BC"}
            </Text>
          </TouchableOpacity>
          <Text style={[styles.groupHeader, isActiveWorkspace ? styles.activeWorkspaceHeaderText : null, isInactiveWorkspace ? { opacity: 0.55 } : null]} numberOfLines={1}>{item.displayGroup}</Text>
        </View>
        {item.tabsToggle && (
          <View
            style={[
              styles.groupHeaderSegmentSlot,
              hook.mobileAppearance ? styles.nativeGroupSegmentRow : null,
            ]}
          >
            <SegmentedControl
              label={`${item.displayGroup} view`}
              value={item.tabsToggle.view}
              onChange={(view) => hook.onGroupTabViewChange?.(item.tabsToggle!.group, view)}
              compact
              style={{ backgroundColor: colors.groupedSurface }}
              options={(["tabs", "jobs"] as const).map((view) => ({
                value: view,
                label: `${view === "tabs" ? "Tabs" : "Jobs"} (${view === "tabs" ? item.tabsToggle!.tabCount : item.tabsToggle!.jobCount})`,
              }))}
            />
          </View>
        )}
        <View style={styles.groupHeaderMenuSlot}>
          {menuButton}
        </View>
      </TouchableOpacity>
    </View>
  );
}
