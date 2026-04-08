import { memo } from "react";
import { TouchableOpacity, View, Text, StyleSheet } from "react-native";
import type { RemoteJob, JobStatus } from "../types/job";
import { StatusBadge } from "./StatusBadge";
import { Tooltip } from "./Tooltip";
import { timeAgo, compactCron } from "../util/format";
import { cronTooltip, nextCronDate, formatNextRun } from "../util/cron";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { JobKindIcon, kindForJob } from "./JobKindIcon";

export const JobCard = memo(function JobCard({
  job,
  status,
  onPress,
  selected,
}: {
  job: RemoteJob;
  status: JobStatus;
  onPress?: () => void;
  selected?: boolean | string;
}) {
  const lastRun =
    status.state === "success"
      ? timeAgo(status.last_run)
      : status.state === "failed"
        ? timeAgo(status.last_run)
        : status.state === "running"
          ? timeAgo(status.started_at)
          : null;

  const kind = kindForJob(job);

  return (
    <TouchableOpacity
      style={[styles.card, !job.enabled && styles.cardDisabled, selected && { borderColor: typeof selected === "string" ? selected : colors.accent, borderWidth: 2 }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.row}>
        <JobKindIcon kind={kind} />
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
  cardDisabled: {
    opacity: 0.5,
  },
  cardSelected: {
    borderColor: colors.accent,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minWidth: 0,
  },
  info: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  name: {
    color: colors.text,
    fontSize: 15,
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
    fontSize: 12,
    fontFamily: "monospace",
    flexShrink: 1,
  },
  metaText: {
    color: colors.textSecondary,
    fontSize: 12,
    flexShrink: 0,
  },
  nextRunText: {
    color: colors.textSecondary,
    fontSize: 12,
    flexShrink: 0,
  },
});
