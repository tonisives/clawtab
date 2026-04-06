import { memo, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import type { JobStatus } from "../types/job";
import { StatusBadge } from "./StatusBadge";
import { PopupMenu } from "./PopupMenu";
import { timeAgo } from "../util/format";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

const isWeb = Platform.OS === "web";

export const RunningJobCard = memo(function RunningJobCard({
  jobName,
  status,
  onPress,
  selected,
  onStop,
  autoYesActive,
  stopping,
}: {
  jobName: string;
  status: JobStatus;
  onPress?: () => void;
  selected?: boolean | string;
  onStop?: () => void;
  autoYesActive?: boolean;
  stopping?: boolean;
}) {
  const startedAt = status.state === "running" ? status.started_at : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<any>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const showMenu = onStop && !stopping;

  return (
    <TouchableOpacity
      style={[styles.card, selected && { borderColor: typeof selected === "string" ? selected : colors.accent, borderWidth: 2 }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.row}>
        <View style={styles.typeIcon}>
          <Text style={styles.typeIconText}>C</Text>
        </View>
        <View style={styles.info}>
          <Text style={[styles.name, stopping && { opacity: 0.5 }]} numberOfLines={1}>{jobName}</Text>
          {stopping ? (
            <Text style={[styles.metaText, { fontStyle: "italic" }]}>Stopping...</Text>
          ) : startedAt ? (
            <Text style={styles.metaText}>{timeAgo(startedAt)}</Text>
          ) : null}
        </View>
        <View style={[styles.rightCol, (showMenu || autoYesActive) && styles.rightColExpanded]}>
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
          ) : (autoYesActive && !stopping) ? <View style={styles.spacer} /> : null}
          {stopping ? (
            <View style={styles.stoppingDot} />
          ) : (
            <StatusBadge status={{ state: "running", started_at: "", run_id: "" }} />
          )}
          {autoYesActive && !stopping ? (
            <View style={styles.autoYesDot} />
          ) : showMenu ? <View style={styles.spacer} /> : null}
        </View>
      </View>
      {menuOpen && showMenu && (
        <PopupMenu
          triggerRef={menuBtnRef}
          position={menuPos}
          onClose={() => setMenuOpen(false)}
          items={[
            { type: "item" as const, label: "Stop", onPress: () => { onStop(); setMenuOpen(false); }, color: colors.danger },
          ]}
        />
      )}
    </TouchableOpacity>
  );
})

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
  stoppingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
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
