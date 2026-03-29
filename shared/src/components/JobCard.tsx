import { TouchableOpacity, View, Text, StyleSheet } from "react-native";
import type { RemoteJob, JobStatus } from "../types/job";
import { StatusBadge } from "./StatusBadge";
import { Tooltip } from "./Tooltip";
import { typeIcon } from "../util/jobs";
import { timeAgo, compactCron } from "../util/format";
import { cronTooltip, nextCronDate, formatNextRun } from "../util/cron";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function JobCard({
  job,
  status,
  onPress,
}: {
  job: RemoteJob;
  status: JobStatus;
  onPress?: () => void;
}) {
  const lastRun =
    status.state === "success"
      ? timeAgo(status.last_run)
      : status.state === "failed"
        ? timeAgo(status.last_run)
        : status.state === "running"
          ? timeAgo(status.started_at)
          : null;

  const icon = typeIcon(job.job_type);

  return (
    <View style={[styles.card, !job.enabled && styles.cardDisabled]}>
      <TouchableOpacity
        style={styles.row}
        onPress={onPress}
        activeOpacity={0.7}
      >
        <View style={[styles.typeIcon, { backgroundColor: icon.bg }]}>
          <Text style={[styles.typeIconText, job.job_type === "claude" && { color: colors.accent }]}>{icon.letter}</Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {job.name}
          </Text>
          <View style={styles.meta}>
            {job.cron ? <Tooltip label={cronTooltip(job.cron)}><Text style={styles.cronText}>{compactCron(job.cron)}</Text></Tooltip> : null}
            {lastRun ? <Text style={styles.metaText}>{lastRun}</Text> : null}
            {job.cron && job.enabled ? (() => {
              const next = nextCronDate(job.cron);
              return next ? <Text style={styles.nextRunText}>next: {formatNextRun(next)}</Text> : null;
            })() : null}
          </View>
        </View>
        <StatusBadge status={status} />
      </TouchableOpacity>
    </View>
  );
}

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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minWidth: 0,
  },
  typeIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    justifyContent: "center",
    alignItems: "center",
  },
  typeIconText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: "monospace",
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
    gap: spacing.sm,
  },
  cronText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: "monospace",
  },
  metaText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  nextRunText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
