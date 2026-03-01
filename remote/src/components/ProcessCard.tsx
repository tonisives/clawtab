import { View, Text, TouchableOpacity, StyleSheet } from "react-native"
import { useRouter } from "expo-router"
import { colors } from "../theme/colors"
import { radius, spacing } from "../theme/spacing"
import type { ClaudeProcess } from "../types/job"

export function ProcessCard({
  process,
}: {
  process: ClaudeProcess
}) {
  const router = useRouter()
  const displayName = process.cwd.replace(/^\/Users\/[^/]+/, "~")

  return (
    <TouchableOpacity
      style={styles.processCard}
      onPress={() => router.push(`/process/${process.pane_id.replace(/%/g, "_pct_")}`)}
      activeOpacity={0.7}
    >
      <View style={styles.processRow}>
        <View style={styles.processTypeIcon}>
          <Text style={styles.processTypeIconText}>C</Text>
        </View>
        <View style={styles.processInfo}>
          <Text style={styles.processName} numberOfLines={1}>
            {displayName}
          </Text>
          <View style={styles.processMeta}>
            <Text style={styles.processMetaText}>v{process.version}</Text>
          </View>
        </View>
        <View style={styles.processRunningBadge}>
          <Text style={styles.processRunningText}>running</Text>
        </View>
      </View>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  processCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    opacity: 0.7,
  },
  processRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  processTypeIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.accentBg,
    justifyContent: "center",
    alignItems: "center",
  },
  processTypeIconText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: "monospace",
    fontStyle: "italic",
  },
  processInfo: { flex: 1, gap: 2 },
  processName: { color: colors.text, fontSize: 15, fontWeight: "500", fontStyle: "italic" },
  processMeta: { flexDirection: "row", gap: spacing.sm },
  processMetaText: { color: colors.textSecondary, fontSize: 12 },
  processRunningBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: colors.accentBg,
  },
  processRunningText: { fontSize: 11, fontWeight: "500", letterSpacing: 0.3, color: colors.accent },
})
