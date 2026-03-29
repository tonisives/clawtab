import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { JobStatus } from "../types/job";
import { StatusBadge } from "./StatusBadge";
import { timeAgo } from "../util/format";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function RunningJobCard({
  jobName,
  status,
  onPress,
  selected,
}: {
  jobName: string;
  status: JobStatus;
  onPress?: () => void;
  selected?: boolean;
}) {
  const startedAt = status.state === "running" ? status.started_at : null;

  return (
    <TouchableOpacity
      style={[styles.card, selected && styles.cardSelected]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.row}>
        <View style={styles.typeIcon}>
          <Text style={styles.typeIconText}>C</Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>{jobName}</Text>
          {startedAt && (
            <Text style={styles.metaText}>{timeAgo(startedAt)}</Text>
          )}
        </View>
        <StatusBadge status={{ state: "running", started_at: "", run_id: "" }} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardSelected: {
    borderColor: colors.accent,
  },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, minWidth: 0 },
  typeIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.accentBg,
    justifyContent: "center",
    alignItems: "center",
  },
  typeIconText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: "monospace",
  },
  info: { flex: 1, gap: 2, minWidth: 0 },
  name: { color: colors.text, fontSize: 15, fontWeight: "500" },
  metaText: { color: colors.textSecondary, fontSize: 12 },
});
