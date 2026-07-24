import { Platform, Text, TouchableOpacity, View } from "react-native";

import { colors } from "../../theme/colors";
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
  const isCollapsed = hook.collapsedGroups.has(item.group);
  const allowGroupMenu = item.group !== "Shells" && (
    hook.onAddJob || (item.hidden ? hook.onUnhideGroup : hook.onHideGroup)
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
        hook.setGroupMenu({ group: item.group, folderPath: item.folderPath, hidden: item.hidden });
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
        Platform.OS !== "web" ? styles.nativeGroupHeaderWrap : null,
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
              Platform.OS !== "web" ? styles.nativeGroupSegmentRow : null,
            ]}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: colors.groupedSurface,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 999,
                padding: Platform.OS === "web" ? 2 : 3,
                height: Platform.OS === "web" ? undefined : 34,
              }}
            >
              {(["tabs", "jobs"] as const).map((view) => {
                const active = item.tabsToggle!.view === view;
                const count = view === "tabs" ? item.tabsToggle!.tabCount : item.tabsToggle!.jobCount;
                const label = view === "tabs" ? "Tabs" : "Jobs";
                return (
                  <TouchableOpacity
                    key={view}
                    onPress={(event: any) => {
                      event?.stopPropagation?.();
                      hook.onGroupTabViewChange?.(item.tabsToggle!.group, view);
                    }}
                    activeOpacity={0.7}
                    style={{
                      paddingHorizontal: Platform.OS === "web" ? 9 : 12,
                      paddingVertical: Platform.OS === "web" ? 2 : 5,
                      borderRadius: 999,
                      backgroundColor: active ? colors.accent : "transparent",
                      justifyContent: "center",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        lineHeight: Platform.OS === "web" ? undefined : 14,
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
          </View>
        )}
        <View style={styles.groupHeaderMenuSlot}>
          {menuButton}
        </View>
      </TouchableOpacity>
    </View>
  );
}
