import { memo, useCallback, useRef, useState } from "react";
import { TouchableOpacity, View, Text, StyleSheet, Platform } from "react-native";
import type { RemoteJob, JobStatus } from "../types/job";
import { StatusBadge } from "./StatusBadge";
import { Tooltip } from "./Tooltip";
import { PopupMenu } from "./PopupMenu";
import type { ProcessProvider } from "../types/process";
import { timeAgo, compactCron } from "../util/format";
import { cronTooltip, nextCronDate, formatNextRun } from "../util/cron";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { JobKindIcon, kindForJob, scheduledProviderKindForJob } from "./JobKindIcon";

type GroupedRowPosition = "single" | "first" | "middle" | "last";

function groupedCardStyle(position?: GroupedRowPosition) {
  if (Platform.OS !== "web" || !position || position === "single") return null;
  if (position === "first") return { backgroundColor: colors.groupedSurface, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 };
  if (position === "last") return { backgroundColor: colors.groupedSurface, borderTopLeftRadius: 0, borderTopRightRadius: 0 };
  return { backgroundColor: colors.groupedSurface, borderRadius: 0 };
}

export const JobCard = memo(function JobCard({
  job,
  status,
  onPress,
  onTogglePin,
  pinned,
  selected,
  softBorder,
  defaultAgentProvider,
  groupedPosition,
}: {
  job: RemoteJob;
  status: JobStatus;
  onPress?: () => void;
  onTogglePin?: () => void;
  pinned?: boolean;
  selected?: boolean | string;
  softBorder?: boolean;
  defaultAgentProvider?: ProcessProvider;
  groupedPosition?: GroupedRowPosition;
}) {
  const lastRun =
    status.state === "success"
      ? timeAgo(status.last_run)
      : status.state === "failed"
        ? timeAgo(status.last_run)
        : status.state === "running"
          ? timeAgo(status.started_at)
          : null;

  const kind = job.cron ? "cron" : kindForJob(job);
  const providerKind = job.cron ? scheduledProviderKindForJob(job, defaultAgentProvider) : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<any>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const openMenu = useCallback((e?: any) => {
    if (!onTogglePin) return;
    if (Platform.OS === "web") {
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
  }, [onTogglePin, pinned]);

  return (
    <View>
      <TouchableOpacity
        ref={menuBtnRef}
        style={[styles.card, selected ? styles.cardSelected : null, !job.enabled && styles.cardDisabled, softBorder && !selected ? styles.cardSoftBorder : null, groupedCardStyle(groupedPosition)]}
        onPress={onPress}
        onLongPress={openMenu}
        activeOpacity={0.7}
      >
        <View style={styles.row}>
          <View style={styles.iconWrap}>
            <JobKindIcon kind={kind} />
            {providerKind ? (
              <View style={styles.providerBadge}>
                <JobKindIcon kind={providerKind} size={14} compact bare />
              </View>
            ) : null}
          </View>
          <View style={styles.info}>
            <Text style={styles.name} numberOfLines={1}>
              {job.name}
            </Text>
            <View style={styles.meta}>
              {job.cron && job.enabled ? (() => {
                const next = nextCronDate(job.cron);
                return next ? <Text style={styles.nextRunText} numberOfLines={1}>{formatNextRun(next)}</Text> : null;
              })() : null}
              {lastRun ? <Text style={styles.metaText}>{lastRun}</Text> : null}
              {job.cron ? <Tooltip label={cronTooltip(job.cron)}><Text style={styles.cronText} numberOfLines={1}>{compactCron(job.cron)}</Text></Tooltip> : null}
            </View>
          </View>
          <StatusBadge status={status} />
        </View>
      </TouchableOpacity>
      {menuOpen && onTogglePin ? (
        <PopupMenu
          triggerRef={menuBtnRef}
          position={menuPos}
          nativePlacement="above"
          onClose={() => setMenuOpen(false)}
          items={[
            { type: "item" as const, label: pinned ? "Unpin" : "Pin", onPress: () => { onTogglePin(); setMenuOpen(false); } },
          ]}
        />
      ) : null}
    </View>
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
  cardDisabled: {
    opacity: 0.5,
  },
  cardSelected: {
    backgroundColor: colors.accentBg,
    borderColor: colors.borderLight,
  },
  cardSoftBorder: {
    borderColor: colors.accent + "55",
    borderWidth: 1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minWidth: 0,
  },
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
  info: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  name: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "500",
  },
  meta: {
    flexDirection: "row",
    flexWrap: "nowrap",
    gap: spacing.sm,
    alignItems: "center",
    overflow: "hidden",
  },
  cronText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontFamily: "monospace",
    flexShrink: 1,
  },
  metaText: {
    color: colors.textSecondary,
    fontSize: 13,
    flexShrink: 0,
  },
  nextRunText: {
    color: colors.textSecondary,
    fontSize: 13,
    flexShrink: 0,
  },
});
