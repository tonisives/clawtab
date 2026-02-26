import { View, Text, TouchableOpacity, StyleSheet } from "react-native"
import { useRouter } from "expo-router"
import { colors } from "../theme/colors"
import { radius, spacing } from "../theme/spacing"

/**
 * Displays a running job card that navigates to the job detail page on tap.
 */
export function RunningJobCard({
  jobName,
}: {
  jobName: string
}) {
  const router = useRouter()

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => router.push(`/job/${jobName}`)}
      activeOpacity={0.7}
    >
      <View style={styles.row}>
        <View style={styles.typeIcon}>
          <Text style={styles.typeIconText}>C</Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>{jobName}</Text>
        </View>
        <View style={styles.runningBadge}>
          <Text style={styles.runningText}>running</Text>
        </View>
      </View>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
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
  info: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 15, fontWeight: "500" },
  runningBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: colors.accentBg,
  },
  runningText: { fontSize: 11, fontWeight: "500", letterSpacing: 0.3, color: colors.accent },
})
