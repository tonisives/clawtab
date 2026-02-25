import { Pressable, View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import type { RemoteJob, JobStatus } from "../types/job";
import { StatusBadge } from "./StatusBadge";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

function typeIcon(jobType: string): { letter: string; bg: string } {
  switch (jobType) {
    case "claude":
      return { letter: "C", bg: colors.accentBg };
    case "binary":
      return { letter: "B", bg: "rgba(152, 152, 157, 0.12)" };
    case "folder":
      return { letter: "F", bg: "rgba(152, 152, 157, 0.12)" };
    default:
      return { letter: "?", bg: "rgba(152, 152, 157, 0.12)" };
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function JobCard({
  job,
  status,
}: {
  job: RemoteJob;
  status: JobStatus;
}) {
  const router = useRouter();

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
    <Pressable
      style={({ pressed }) => [
        styles.card,
        pressed && styles.cardPressed,
        !job.enabled && styles.cardDisabled,
      ]}
      onPress={() => router.push(`/job/${job.name}`)}
    >
      <View style={styles.row}>
        <View style={[styles.typeIcon, { backgroundColor: icon.bg }]}>
          <Text style={[styles.typeIconText, job.job_type === "claude" && { color: colors.accent }]}>{icon.letter}</Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {job.name}
          </Text>
          <View style={styles.meta}>
            {job.cron ? (
              <Text style={styles.cronText}>{job.cron}</Text>
            ) : null}
            {lastRun ? (
              <Text style={styles.metaText}>{lastRun}</Text>
            ) : null}
          </View>
        </View>
        <StatusBadge status={status} />
      </View>
    </Pressable>
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
  cardPressed: {
    backgroundColor: colors.surfaceHover,
  },
  cardDisabled: {
    opacity: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
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
});
