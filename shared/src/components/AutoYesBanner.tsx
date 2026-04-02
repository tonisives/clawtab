import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

const COLLAPSE_THRESHOLD = 3;

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
}

export function AutoYesBanner({ entries, onDisable, onPress }: AutoYesBannerProps) {
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) return null;

  const shouldCollapse = entries.length > COLLAPSE_THRESHOLD;
  const visibleEntries = shouldCollapse && !expanded ? [] : entries;

  return (
    <View style={styles.container}>
      {shouldCollapse && (
        <TouchableOpacity
          style={styles.row}
          onPress={() => setExpanded(!expanded)}
          activeOpacity={0.7}
        >
          <Text style={styles.label}>
            ! Auto-yes: {entries.length} panes {expanded ? "(collapse)" : "(expand)"}
          </Text>
        </TouchableOpacity>
      )}
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 4,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.warningBg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warning,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
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
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  disableBtnText: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: "500",
  },
});
