import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { ClaudeProcess } from "../types/process";
import { shortenPath } from "../util/format";
import { Tooltip } from "./Tooltip";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function ProcessCard({
  process,
  onPress,
  inGroup,
  selected,
}: {
  process: ClaudeProcess;
  onPress?: () => void;
  inGroup?: boolean;
  selected?: boolean | string;
}) {
  const displayName = inGroup
    ? (process.first_query ?? shortenPath(process.cwd))
    : shortenPath(process.cwd);

  const subtitle = inGroup
    ? (process.last_query && process.last_query !== process.first_query ? process.last_query : null)
    : (process.first_query ?? null);

  const transient = process._transient_state;

  const statusWithTitle = transient ? (
    <View style={[
      styles.statusDot,
      transient === "starting" ? styles.statusDotStarting : styles.statusDotStopping,
    ]} />
  ) : (
    <Tooltip label="Running">
      <View style={styles.statusDot} />
    </Tooltip>
  );

  return (
    <View style={[styles.processCard, selected && { borderColor: typeof selected === "string" ? selected : colors.accent, opacity: 1 }]}>
      <TouchableOpacity
        style={styles.processRow}
        onPress={onPress}
        activeOpacity={0.7}
      >
        <View style={styles.processTypeIcon}>
          <Text style={styles.processTypeIconText}>C</Text>
        </View>
        <View style={styles.processInfo}>
          <Text style={[styles.processName, transient === "stopping" && { opacity: 0.5 }]} numberOfLines={1}>
            {displayName}
          </Text>
          {transient ? (
            <Text style={[styles.queryPreview, { fontStyle: "italic" }]} numberOfLines={1}>
              {transient === "starting" ? "Starting..." : "Stopping..."}
            </Text>
          ) : subtitle ? (
            <Text style={styles.queryPreview} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {statusWithTitle}
      </TouchableOpacity>
    </View>
  );
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
  processCardSelected: {
    borderColor: colors.accent,
    opacity: 1,
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
  processInfo: { flex: 1, gap: 2, minWidth: 0 },
  processName: { color: colors.text, fontSize: 13, fontWeight: "500" },
  queryPreview: {
    color: colors.textMuted,
    fontSize: 11,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.statusRunning,
    flexShrink: 0,
  },
  statusDotStarting: {
    backgroundColor: "#f59e0b",
    opacity: 0.7,
  },
  statusDotStopping: {
    backgroundColor: colors.textMuted,
    opacity: 0.5,
  },
});
