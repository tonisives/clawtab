import { memo, useCallback, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import type { JobStatus, RemoteJob } from "../types/job";
import type { ProcessProvider } from "../types/process";
import { StatusBadge } from "./StatusBadge";
import { PopupMenu } from "./PopupMenu";
import { JobKindIcon, scheduledProviderKindForJob } from "./JobKindIcon";
import { isJobScheduled } from "../util/schedule";
import { timeAgo } from "../util/format";
import { compactAgentSelectionLabel } from "../util/agent";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

const isWeb = Platform.OS === "web";
type GroupedRowPosition = "single" | "first" | "middle" | "last";

function groupedCardStyle(position?: GroupedRowPosition) {
  if (!isWeb || !position || position === "single") return null;
  if (position === "first") return { backgroundColor: colors.groupedSurface, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 };
  if (position === "last") return { backgroundColor: colors.groupedSurface, borderTopLeftRadius: 0, borderTopRightRadius: 0 };
  return { backgroundColor: colors.groupedSurface, borderRadius: 0 };
}

export const RunningJobCard = memo(function RunningJobCard({
  job,
  status,
  onPress,
  selected,
  softBorder,
  onStop,
  onTogglePin,
  pinned,
  autoYesActive,
  stopping,
  defaultAgentProvider,
  defaultAgentModel,
  groupedPosition,
}: {
  job: RemoteJob;
  status: JobStatus;
  onPress?: () => void;
  selected?: boolean | string;
  softBorder?: boolean;
  onStop?: () => void;
  onTogglePin?: () => void;
  pinned?: boolean;
  autoYesActive?: boolean;
  stopping?: boolean;
  defaultAgentProvider?: ProcessProvider;
  defaultAgentModel?: string | null;
  groupedPosition?: GroupedRowPosition;
}) {
  const startedAt = status.state === "running" ? status.started_at : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<any>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const showMenu = (onStop || onTogglePin) && !stopping;
  const agentProvider = job.agent_provider ?? scheduledProviderKindForJob(job, defaultAgentProvider);
  const agentModel = job.agent_model
    ?? (agentProvider === defaultAgentProvider ? defaultAgentModel : null);
  const agentLabel = agentProvider ? compactAgentSelectionLabel(agentProvider, agentModel, job.agent_effort) : null;
  const openMenu = useCallback((e?: any) => {
    if (!showMenu) return;
    if (isWeb) {
      const node = e?.currentTarget ?? e?.target;
      if (node?.getBoundingClientRect) {
        const rect = node.getBoundingClientRect();
        setMenuPos({ top: rect.bottom + 4, left: rect.right });
      }
    } else if (e?.nativeEvent) {
      setMenuPos({
        top: e.nativeEvent.pageY ?? 44,
        left: e.nativeEvent.pageX ?? 12,
      });
    }
    setMenuOpen(true);
  }, [onStop, onTogglePin, pinned, showMenu]);

  return (
    <TouchableOpacity
      style={[styles.card, selected ? styles.cardSelected : null, softBorder && !selected ? styles.cardSoftBorder : null, groupedCardStyle(groupedPosition)]}
      onPress={onPress}
      onLongPress={openMenu}
      activeOpacity={0.7}
    >
      <View style={styles.row}>
        <View style={styles.iconWrap}>
          <JobKindIcon kind={isJobScheduled(job) ? "cron" : "manual"} />
          {(() => { const pk = scheduledProviderKindForJob(job, defaultAgentProvider); return pk ? <View style={styles.providerBadge}><JobKindIcon kind={pk} size={14} compact bare /></View> : null; })()}
        </View>
        <View style={styles.info}>
          <View style={styles.titleRow}>
            <Text style={[styles.name, stopping && { opacity: 0.5 }]} numberOfLines={1}>{job.name}</Text>
            <View style={styles.titleControls}>
              {showMenu ? (
                <TouchableOpacity
                  ref={menuBtnRef}
                  onPress={(e: any) => {
                    e.stopPropagation();
                    if (menuOpen) setMenuOpen(false);
                    else openMenu(e);
                  }}
                  style={styles.moreBtn}
                  activeOpacity={0.6}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.moreBtnText}>{"\u2026"}</Text>
                </TouchableOpacity>
              ) : null}
              {stopping ? <View style={styles.stoppingDot} /> : <StatusBadge status={{ state: "running", started_at: "", run_id: "" }} colorOverride={autoYesActive ? colors.warning : undefined} />}
              {autoYesActive && !stopping ? <View style={styles.autoYesDot} /> : null}
            </View>
          </View>
          {stopping ? (
            <Text style={[styles.metaText, { fontStyle: "italic" }]}>Stopping...</Text>
          ) : startedAt ? (
            <View style={styles.runningMeta}>
              <Text style={styles.metaText}>{timeAgo(startedAt)}</Text>
              {agentLabel ? <Text style={styles.agentText} numberOfLines={1}>{agentLabel}</Text> : null}
            </View>
          ) : null}
        </View>
      </View>
      {menuOpen && showMenu && (
        <PopupMenu
          triggerRef={menuBtnRef}
          position={menuPos}
          nativePlacement="above"
          onClose={() => setMenuOpen(false)}
          items={[
            ...(onTogglePin ? [{ type: "item" as const, label: pinned ? "Unpin" : "Pin", onPress: () => { onTogglePin(); setMenuOpen(false); } }] : []),
            ...(onTogglePin && onStop ? [{ type: "separator" as const }] : []),
            ...(onStop ? [{ type: "item" as const, label: "Stop", onPress: () => { onStop(); setMenuOpen(false); }, color: colors.danger }] : []),
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
    position: "relative",
    overflow: "hidden",
    ...(Platform.OS !== "web"
      ? {
          borderRadius: 0,
          borderWidth: 0,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.borderLight,
          paddingVertical: spacing.lg,
        }
      : {}),
  },
  cardSelected: {
    backgroundColor: colors.accentBg,
    borderColor: colors.borderLight,
  },
  cardSoftBorder: {
    borderColor: colors.accent + "55",
    borderWidth: 1,
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
  name: { color: colors.text, fontSize: 17, fontWeight: "500", flex: 1 },
  titleRow: { flexDirection: "row", alignItems: "center", minWidth: 0 },
  titleControls: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginLeft: spacing.sm },
  metaText: { color: colors.textSecondary, fontSize: 13 },
  runningMeta: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minWidth: 0 },
  agentText: { color: colors.accent, fontSize: 12, fontFamily: "monospace", flexShrink: 1 },
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
