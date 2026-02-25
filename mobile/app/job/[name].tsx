import { useCallback, useEffect } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { useJob, useJobStatus } from "../../src/store/jobs";
import { StatusBadge } from "../../src/components/StatusBadge";
import { LogViewer } from "../../src/components/LogViewer";
import { MessageInput } from "../../src/components/MessageInput";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useResponsive } from "../../src/hooks/useResponsive";
import { useLogs } from "../../src/hooks/useLogs";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { colors } from "../../src/theme/colors";
import { radius, spacing } from "../../src/theme/spacing";

export default function JobDetailScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const job = useJob(name);
  const status = useJobStatus(name);
  const { logs } = useLogs(name);
  const { isWide } = useResponsive();

  useEffect(() => {
    const send = getWsSend();
    if (send && name) {
      send({ type: "subscribe_logs", id: nextId(), name });
    }
    return () => {
      const send = getWsSend();
      if (send) {
        send({ type: "unsubscribe_logs", name });
      }
    };
  }, [name]);

  const handleAction = useCallback(
    (action: "run_job" | "pause_job" | "resume_job" | "stop_job") => {
      const send = getWsSend();
      if (send) {
        send({ type: action, id: nextId(), name });
      }
    },
    [name],
  );

  const handleSendInput = useCallback(
    (text: string) => {
      const send = getWsSend();
      if (send) {
        send({ type: "send_input", id: nextId(), name, text });
      }
    },
    [name],
  );

  if (!job) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: name }} />
        <View style={styles.center}>
          <Text style={styles.notFound}>Job not found</Text>
        </View>
      </View>
    );
  }

  const state = status.state;
  const isRunning = state === "running";
  const isPaused = state === "paused";

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: job.name,
          headerRight: () => (
            <View style={styles.headerActions}>
              <StatusBadge status={status} />
            </View>
          ),
        }}
      />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.contentOuter}>
        <ContentContainer wide>
          <View style={[styles.content, isWide && styles.contentWide]}>
            {/* Info row */}
            <View style={styles.infoRow}>
              <Text style={styles.jobType}>{job.job_type}</Text>
              {job.cron ? <Text style={styles.cron}>{job.cron}</Text> : null}
            </View>

            {/* Action buttons - matching desktop style */}
            <View style={styles.actions}>
              {isRunning && (
                <>
                  <ActionButton label="Pause" color={colors.warning} onPress={() => handleAction("pause_job")} />
                  <ActionButton label="Stop" color={colors.danger} onPress={() => handleAction("stop_job")} />
                </>
              )}
              {isPaused && (
                <>
                  <ActionButton label="Resume" color={colors.success} filled onPress={() => handleAction("resume_job")} />
                  <ActionButton label="Stop" color={colors.danger} onPress={() => handleAction("stop_job")} />
                </>
              )}
              {state === "failed" && (
                <ActionButton label="Restart" color={colors.accent} filled onPress={() => handleAction("run_job")} />
              )}
              {state === "success" && (
                <ActionButton label="Run Again" color={colors.accent} filled onPress={() => handleAction("run_job")} />
              )}
              {(state === "idle") && (
                <ActionButton label="Run" color={colors.accent} filled onPress={() => handleAction("run_job")} />
              )}
            </View>

            {/* Live Output */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                {isRunning ? "Live Output" : "Output"}
              </Text>
              <View style={styles.logsContainer}>
                <LogViewer content={logs} />
              </View>
            </View>
          </View>
        </ContentContainer>
      </ScrollView>

      {/* Input bar for running/paused jobs */}
      {(isRunning || isPaused) && (
        <MessageInput onSend={handleSendInput} placeholder="Send input to job..." />
      )}
    </View>
  );
}

function ActionButton({
  label,
  color,
  onPress,
  filled,
}: {
  label: string;
  color: string;
  onPress: () => void;
  filled?: boolean;
}) {
  return (
    <Pressable
      style={[
        styles.actionBtn,
        filled
          ? { backgroundColor: color }
          : { borderColor: color, borderWidth: 1 },
      ]}
      onPress={onPress}
    >
      <Text style={[styles.actionText, { color: filled ? "#fff" : color }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    flex: 1,
  },
  contentOuter: {
    flexGrow: 1,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  contentWide: {
    paddingTop: 32,
    paddingHorizontal: spacing.xl,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  notFound: {
    color: colors.textMuted,
    fontSize: 16,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginRight: 4,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  jobType: {
    color: colors.textSecondary,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontWeight: "600",
  },
  cron: {
    color: colors.textMuted,
    fontSize: 12,
    fontFamily: "monospace",
  },
  actions: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  actionBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  actionText: {
    fontSize: 14,
    fontWeight: "600",
  },
  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  logsContainer: {
    height: 400,
  },
});
