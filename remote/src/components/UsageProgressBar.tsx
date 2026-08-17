import { useEffect, useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { colors } from "../theme/colors"

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function parseUsagePercent(value: string | null | undefined): number | null {
  if (!value) return null
  const match = value.match(/(\d+(?:\.\d+)?)\s*%/)
  if (!match) return null
  const percent = Number(match[1])
  return Number.isFinite(percent) ? clamp(percent) : null
}

export function weekProgressPercent(resetAt?: number | null, date = new Date()): number {
  const resetAtMs = typeof resetAt === "number" && Number.isFinite(resetAt)
    ? resetAt * 1000
    : null
  if (resetAtMs != null) {
    return clamp(((date.getTime() - (resetAtMs - WEEK_MS)) / WEEK_MS) * 100)
  }

  const start = new Date(date)
  const daysSinceMonday = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - daysSinceMonday)
  start.setHours(0, 0, 0, 0)
  return clamp(((date.getTime() - start.getTime()) / WEEK_MS) * 100)
}

export function UsageProgressBar({
  usagePercent,
  resetAt,
  label = "Weekly model usage",
}: {
  usagePercent: number | null | undefined
  resetAt?: number | null
  label?: string
}) {
  const [weekProgress, setWeekProgress] = useState(() => weekProgressPercent(resetAt))

  useEffect(() => {
    setWeekProgress(weekProgressPercent(resetAt))
    const timer = setInterval(() => setWeekProgress(weekProgressPercent(resetAt)), 60_000)
    return () => clearInterval(timer)
  }, [resetAt])

  if (usagePercent == null) return null

  const usage = clamp(usagePercent)
  const roundedUsage = Math.round(usage)
  const roundedWeek = Math.round(weekProgress)
  const delta = roundedUsage - roundedWeek
  const paceLabel = resetAt != null ? "reset-based week" : "calendar week"
  const comparison = delta === 0
    ? "On pace"
    : delta > 0
      ? `${delta} pts ahead of week pace`
      : `${Math.abs(delta)} pts behind week pace`

  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityLabel={`${label}: ${roundedUsage}% used, ${comparison}`}
    >
      <View style={styles.header}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.usage}>{roundedUsage}%</Text>
      </View>
      <View style={styles.trackWrap}>
        <View style={styles.track}>
          <View style={[styles.weekFill, { width: `${weekProgress}%` }]} />
        </View>
        <View
          pointerEvents="none"
          style={[styles.usageMarker, { left: `${usage}%` }]}
        />
      </View>
      <View style={styles.footer}>
        <Text style={styles.legend}>solid: {paceLabel} {roundedWeek}%</Text>
        <Text style={[styles.comparison, delta > 0 && styles.ahead]}>{comparison}</Text>
      </View>
    </View>
  )
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value))
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    gap: 6,
  },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  usage: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  trackWrap: {
    height: 14,
    justifyContent: "center",
    position: "relative",
  },
  track: {
    height: 8,
    borderRadius: 4,
    overflow: "hidden",
    backgroundColor: colors.border,
  },
  weekFill: {
    height: "100%",
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  usageMarker: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    borderLeftWidth: 2,
    borderLeftColor: colors.text,
    borderStyle: "dotted",
    transform: [{ translateX: -1 }],
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  legend: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 10,
  },
  comparison: {
    color: colors.warning,
    fontSize: 10,
    fontWeight: "600",
    textAlign: "right",
  },
  ahead: {
    color: colors.danger,
  },
})
