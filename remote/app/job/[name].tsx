import { useCallback, useEffect, useState } from "react";
import { Alert, View, Text, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useJob, useJobStatus } from "../../src/store/jobs";
import { useRunsStore } from "../../src/store/runs";
import { useNotificationStore } from "../../src/store/notifications";
import { StatusBadge } from "@clawtab/shared";
import { JobDetailView, findYesOption } from "@clawtab/shared";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useLogs } from "../../src/hooks/useLogs";
import { createWsTransport } from "../../src/transport/wsTransport";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { registerRequest } from "../../src/lib/useRequestMap";
import { colors } from "@clawtab/shared";
import type { RunRecord } from "@clawtab/shared";

const wsTransport = createWsTransport();

export default function JobDetailScreen() {
  const { name, run_id } = useLocalSearchParams<{ name: string; run_id?: string }>();
  const job = useJob(name);
  const status = useJobStatus(name);
  const { logs } = useLogs(name);
  const runs = useRunsStore((s) => s.runs[name]) ?? null;
  const router = useRouter();
  const [runsLoading, setRunsLoading] = useState(false);

  const questions = useNotificationStore((s) => s.questions);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const enableAutoYes = useNotificationStore((s) => s.enableAutoYes);
  const disableAutoYes = useNotificationStore((s) => s.disableAutoYes);
  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const jobQuestion = questions.find((q) => q.matched_job === name);
  const autoYesActive = jobQuestion ? autoYesPaneIds.has(jobQuestion.pane_id) : false;

  const loadRuns = useCallback(() => {
    const send = getWsSend();
    if (!send || !name) return;
    const id = nextId();
    setRunsLoading(true);
    send({ type: "get_run_history", id, name, limit: 50 });
    registerRequest<RunRecord[]>(id).then((result) => {
      useRunsStore.getState().setRuns(name, result);
      setRunsLoading(false);
    });
  }, [name]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const handleToggleAutoYes = useCallback(() => {
    if (!jobQuestion) return;
    if (autoYesPaneIds.has(jobQuestion.pane_id)) {
      disableAutoYes(jobQuestion.pane_id);
      const send = getWsSend();
      if (send) {
        const next = new Set(autoYesPaneIds);
        next.delete(jobQuestion.pane_id);
        send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] });
      }
      return;
    }
    const title = jobQuestion.matched_job ?? jobQuestion.cwd.replace(/^\/Users\/[^/]+/, "~");
    Alert.alert(
      "Enable auto-yes?",
      `All future questions for "${title}" will be automatically accepted with "Yes". This stays active until you disable it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Enable",
          style: "destructive",
          onPress: () => {
            enableAutoYes(jobQuestion.pane_id);
            const send = getWsSend();
            if (send) {
              const next = new Set(autoYesPaneIds);
              next.add(jobQuestion.pane_id);
              send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] });
            }
            const yesOpt = findYesOption(jobQuestion);
            if (yesOpt) {
              const s = getWsSend();
              if (s) s({ type: "send_input", id: nextId(), name: name, text: yesOpt });
              setTimeout(() => answerQuestion(jobQuestion.question_id), 1500);
            }
          },
        },
      ],
    );
  }, [jobQuestion, autoYesPaneIds, enableAutoYes, disableAutoYes, answerQuestion, name]);

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

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: job.name,
          headerRight: () => <StatusBadge status={status} />,
        }}
      />
      <ContentContainer wide>
        <JobDetailView
          transport={wsTransport}
          job={job}
          status={status}
          logs={logs}
          runs={runs}
          runsLoading={runsLoading}
          onBack={() => router.back()}
          onReloadRuns={loadRuns}
          expandRunId={run_id}
          options={jobQuestion?.options}
          autoYesActive={autoYesActive}
          onToggleAutoYes={jobQuestion ? handleToggleAutoYes : undefined}
        />
      </ContentContainer>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
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
});
