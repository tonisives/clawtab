import { useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import type { ClaudeProcess } from "../types/process";
import { PopupMenu } from "./PopupMenu";
import { shortenPath } from "../util/format";
import { Tooltip } from "./Tooltip";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { JobKindIcon, kindForProcess } from "./JobKindIcon";

const isWeb = Platform.OS === "web";

export function ProcessCard({
  process,
  onPress,
  inGroup,
  selected,
  onStop,
  autoYesActive,
}: {
  process: ClaudeProcess;
  onPress?: () => void;
  inGroup?: boolean;
  selected?: boolean | string;
  onStop?: () => void;
  autoYesActive?: boolean;
}) {
  const displayName = inGroup
    ? (process.first_query ?? shortenPath(process.cwd))
    : shortenPath(process.cwd);

  const subtitle = inGroup
    ? (process.last_query && process.last_query !== process.first_query ? process.last_query : null)
    : (process.first_query ?? null);

  const transient = process._transient_state;
  const TEN_MINUTES = 10 * 60 * 1000;
  const recentActivity = !transient && (
    !process._last_log_change || (Date.now() - process._last_log_change < TEN_MINUTES)
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<any>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const statusDot = transient ? (
    <View style={[
      styles.statusDot,
      transient === "starting" ? styles.statusDotStarting : styles.statusDotStopping,
    ]} />
  ) : (
    <Tooltip label={recentActivity ? "Running" : "Idle"}>
      <View style={[styles.statusDot, !recentActivity && styles.statusDotIdle]} />
    </Tooltip>
  );

  const showMenu = onStop && !transient;
  const kind = kindForProcess(process);

  return (
    <View style={[styles.processCard, selected && { borderColor: typeof selected === "string" ? selected : colors.accent, borderWidth: 2, opacity: 1 }]}>
      <TouchableOpacity
        style={styles.processRow}
        onPress={onPress}
        activeOpacity={0.7}
      >
        <JobKindIcon kind={kind} />
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
        <View style={[styles.rightCol, (showMenu || (autoYesActive && !transient)) && styles.rightColExpanded]}>
          {showMenu ? (
            <TouchableOpacity
              ref={menuBtnRef}
              onPress={(e: any) => {
                e.stopPropagation();
                if (isWeb) {
                  const node = e?.currentTarget ?? e?.target;
                  if (node?.getBoundingClientRect) {
                    const rect = node.getBoundingClientRect();
                    setMenuPos({ top: rect.bottom + 4, left: rect.right });
                  }
                }
                setMenuOpen((v) => !v);
              }}
              style={styles.moreBtn}
              activeOpacity={0.6}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.moreBtnText}>{"\u2026"}</Text>
            </TouchableOpacity>
          ) : (autoYesActive && !transient) ? <View style={styles.spacer} /> : null}
          {statusDot}
          {autoYesActive && !transient ? (
            <View style={styles.autoYesDot} />
          ) : showMenu ? <View style={styles.spacer} /> : null}
        </View>
      </TouchableOpacity>
      {menuOpen && onStop && (
        <PopupMenu
          triggerRef={menuBtnRef}
          position={menuPos}
          onClose={() => setMenuOpen(false)}
          items={[
            { type: "item" as const, label: "Stop", onPress: () => { onStop(); setMenuOpen(false); }, color: colors.danger },
          ]}
        />
      )}
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
    backgroundColor: colors.accent,
    opacity: 0.5,
  },
  statusDotStopping: {
    backgroundColor: colors.textMuted,
    opacity: 0.5,
  },
  statusDotIdle: {
    backgroundColor: colors.statusIdle,
  },
  rightCol: {
    alignItems: "center",
    justifyContent: "center",
    height: 32,
  },
  rightColExpanded: {
    justifyContent: "space-between",
    height: 50,
    marginTop: -13,
    marginBottom: -5,
    marginRight: -6,
  },
  spacer: {
    height: 8,
  },
  autoYesDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.warning,
  },
  moreBtn: {
    width: 20,
    height: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  moreBtnText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 14,
  },
});
