import { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";

export interface AutoYesEntry {
  paneId: string;
  label: string;
  /** Job slug if this pane belongs to a known job */
  jobSlug?: string | null;
}

export interface AutoYesBannerProps {
  entries: AutoYesEntry[];
  onDisable: (paneId: string) => void;
  onPress?: (entry: AutoYesEntry) => void;
  /** Limit the number of entries shown before the user expands the list. */
  maxVisibleEntries?: number;
}

export function AutoYesBanner({ entries, onDisable, onPress, maxVisibleEntries }: AutoYesBannerProps) {
  const collapseLimit = maxVisibleEntries == null
    ? entries.length
    : Math.max(1, Math.floor(maxVisibleEntries));
  const isCollapsible = entries.length > collapseLimit;
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) return null;

  const visibleEntries = isCollapsible && !expanded
    ? entries.slice(0, collapseLimit)
    : entries;

  return (
    <View style={styles.container}>
      {isCollapsible && (
        <TouchableOpacity
          style={[styles.row, styles.toggleRow]}
          onPress={() => setExpanded((value) => !value)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Collapse auto-yes panes" : "Expand auto-yes panes"}
        >
          <Text style={styles.label} numberOfLines={1}>Auto-yes: {entries.length} panes</Text>
          <Text style={styles.toggleText}>{expanded ? "Collapse" : "Expand"}</Text>
        </TouchableOpacity>
      )}
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator={visibleEntries.length > 3}
      >
        {visibleEntries.map((e) => (
          <TouchableOpacity
            key={e.paneId}
            style={styles.row}
            onPress={onPress ? () => onPress(e) : undefined}
            activeOpacity={onPress ? 0.7 : 1}
            disabled={!onPress}
          >
            <Text style={styles.label} numberOfLines={1}>! Auto-yes: {e.label}</Text>
            <TouchableOpacity
              style={styles.disableBtn}
              onPress={(ev) => { ev.stopPropagation(); onDisable(e.paneId); }}
              activeOpacity={0.6}
            >
              <Text style={styles.disableBtnText}>Disable</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.sm,
  },
  list: {
    maxHeight: 110,
  },
  listContent: {
    gap: 4,
  },
  row: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.warningBg,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.warning,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  toggleRow: {
    marginBottom: 4,
    backgroundColor: colors.surface,
  },
  label: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
  },
  disableBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  disableBtnText: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: "500",
  },
  toggleText: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: "700",
  },
});
