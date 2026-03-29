import { useState } from "react";
import { TouchableOpacity, View, Text, StyleSheet } from "react-native";
import type { RemoteJob, JobStatus } from "../types/job";
import { StatusBadge } from "./StatusBadge";
import { Tooltip } from "./Tooltip";
import { typeIcon } from "../util/jobs";
import { timeAgo, compactCron, shortenPath } from "../util/format";
import { cronTooltip, nextCronDate, formatNextRun } from "../util/cron";
import { statusLabel } from "../util/status";
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
  const [expanded, setExpanded] = useState(false);

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
      <View style={styles.topRow}>
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
            {!expanded && (
              <View style={styles.meta}>
                {job.cron ? <Tooltip label={cronTooltip(job.cron)}><Text style={styles.cronText}>{compactCron(job.cron)}</Text></Tooltip> : null}
                {lastRun ? <Text style={styles.metaText}>{lastRun}</Text> : null}
                {job.cron && job.enabled ? (() => {
                  const next = nextCronDate(job.cron);
                  return next ? <Text style={styles.nextRunText}>next: {formatNextRun(next)}</Text> : null;
                })() : null}
              </View>
            )}
          </View>
          <StatusBadge status={status} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.chevronBtn}
          onPress={() => setExpanded((v) => !v)}
          activeOpacity={0.6}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.chevronText}>{expanded ? "\u25BC" : "\u25B6"}</Text>
        </TouchableOpacity>
      </View>

      {expanded && (
        <View style={styles.details}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Status</Text>
            <Text style={styles.detailValue}>{statusLabel(status)}</Text>
          </View>
          {job.cron ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Cron</Text>
              <Tooltip label={cronTooltip(job.cron)}>
                <Text style={styles.detailValue}>{compactCron(job.cron)}</Text>
              </Tooltip>
            </View>
          ) : null}
          {lastRun ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Last run</Text>
              <Text style={styles.detailValue}>{lastRun}</Text>
            </View>
          ) : null}
          {job.cron && job.enabled ? (() => {
            const next = nextCronDate(job.cron);
            return next ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Next</Text>
                <Text style={styles.detailValue}>{formatNextRun(next)}</Text>
              </View>
            ) : null;
          })() : null}
          {(job.folder_path || job.work_dir) ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Path</Text>
              <Text style={styles.detailValue} numberOfLines={1}>{shortenPath(job.folder_path || job.work_dir)}</Text>
            </View>
          ) : null}
          {status.state === "failed" ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Exit</Text>
              <Text style={[styles.detailValue, { color: colors.danger }]}>{status.exit_code}</Text>
            </View>
          ) : null}
        </View>
      )}
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
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  row: {
    flex: 1,
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
  chevronBtn: {
    width: 24,
    height: 24,
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  chevronText: {
    color: colors.textSecondary,
    fontSize: 9,
    fontFamily: "monospace",
  },
  details: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 6,
  },
  detailRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  detailLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    width: 50,
    flexShrink: 0,
  },
  detailValue: {
    color: colors.text,
    fontSize: 11,
    fontFamily: "monospace",
    flex: 1,
  },
});
