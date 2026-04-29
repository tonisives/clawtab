import { memo, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import type { JobStatus, RemoteJob } from "../types/job";
import { StatusBadge } from "./StatusBadge";
import { PopupMenu } from "./PopupMenu";
import { JobKindIcon, kindForJob, providerKindForJob, type JobKind } from "./JobKindIcon";
import { timeAgo } from "../util/format";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

const isWeb = Platform.OS === "web";

export const RunningJobCard = memo(function RunningJobCard({
  job,
  status,
  onPress,
  selected,
  softBorder,
  onStop,
  autoYesActive,
  stopping,
  defaultAgentProvider,
}: {
  job: RemoteJob;
  status: JobStatus;
  onPress?: () => void;
  selected?: boolean | string;
  softBorder?: boolean;
  onStop?: () => void;
  autoYesActive?: boolean;
  stopping?: boolean;
  defaultAgentProvider?: JobKind;
}) {
  const startedAt = status.state === "running" ? status.started_at : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<any>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const showMenu = onStop && !stopping;
  return (
    <TouchableOpacity
      style={[styles.card, selected ? { borderColor: typeof selected === "string" ? selected : colors.accent, borderWidth: 2, boxShadow: "inset 1px 1px 0 rgba(255,255,255,0.1), 1px 1px 0 rgba(0,0,0,0.18)" } : softBorder ? { borderColor: colors.accent + "55", borderWidth: 1 } : null]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.row}>
        {job.cron ? (
          <View style={styles.iconWrap}>
            <JobKindIcon kind="cron" />
            {(() => { const pk = providerKindForJob(job) ?? defaultAgentProvider ?? null; return pk ? <View style={styles.providerBadge}><JobKindIcon kind={pk} size={14} compact bare /></View> : null; })()}
          </View>
        ) : (
          <View style={styles.iconWrap}>
            <JobKindIcon kind={kindForJob(job)} />
          </View>
        )}
        <View style={styles.info}>
          <Text style={[styles.name, stopping && { opacity: 0.5 }]} numberOfLines={1}>{job.name}</Text>
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
  iconWrap: {
    position: "relative",
    width: 32,
    height: 32,
    flexShrink: 0,
  },
  providerBadge: {
    position: "absolute",
    top: -3,
    right: -3,
    width: 16,
    height: 16,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
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
