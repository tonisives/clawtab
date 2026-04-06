import { useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import type { ClaudeProcess } from "../types/process";
import { PopupMenu } from "./PopupMenu";
import { shortenPath } from "../util/format";
import { Tooltip } from "./Tooltip";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

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

  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<any>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const statusDot = transient ? (
    <View style={[
      styles.statusDot,
      transient === "starting" ? styles.statusDotStarting : styles.statusDotStopping,
    ]} />
  ) : (
    <Tooltip label="Running">
      <View style={styles.statusDot} />
    </Tooltip>
  );

  const showMenu = onStop && !transient;

  return (
    <View style={[styles.processCard, selected && { borderColor: typeof selected === "string" ? selected : colors.accent, borderWidth: 2, opacity: 1 }]}>
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
        {autoYesActive && !transient && (
          <View style={styles.autoYesDot} />
        )}
        {statusDot}
        {showMenu && (
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
        )}
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
  autoYesDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.warning,
  },
  moreBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
    alignSelf: "flex-start",
    marginTop: -4,
    marginRight: -6,
    marginLeft: -4,
  },
  moreBtnText: {
    color: colors.textSecondary,
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 18,
    letterSpacing: 1,
  },
});
