import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, View, Text, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { BackTitle } from "./_layout";
import { useJob, useJobStatus, useJobsStore } from "../../src/store/jobs";
import { useRunsStore } from "../../src/store/runs";
import { useNotificationStore } from "../../src/store/notifications";
import { useWsStore } from "../../src/store/ws";
import { StatusBadge } from "@clawtab/shared";
import { JobDetailView, findYesOption } from "@clawtab/shared";
import { ContentContainer } from "../../src/components/ContentContainer";
import { DemoBanner } from "../../src/components/DemoOverlay";
import { useLogs } from "../../src/hooks/useLogs";
import { createWsTransport } from "../../src/transport/wsTransport";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { registerRequest } from "../../src/lib/useRequestMap";
import { DEMO_JOBS, DEMO_STATUSES, DEMO_LOGS, DEMO_RUNS, isDemoJob } from "../../src/demo/data";
import { colors } from "@clawtab/shared";
import type { Transport } from "@clawtab/shared";
import type { RemoteJob, RunRecord } from "@clawtab/shared";

const wsTransport = createWsTransport();

const noop = async () => {};
const demoTransport: Transport = {
  listJobs: async () => ({ jobs: [], statuses: {} }),
  getStatuses: async () => ({}),
  runJob: noop,
  stopJob: noop,
  pauseJob: noop,
  resumeJob: noop,
  toggleJob: noop,
  deleteJob: noop,
  getRunHistory: async () => [],
  getRunDetail: async () => null,
  detectProcesses: async () => [],
  sendInput: noop,
  subscribeLogs: () => () => {},
  runAgent: noop,
};

function agentJobFromSlug(slug: string): RemoteJob {
  const folder = slug.replace(/^agent-/, "");
  return {
    name: slug,
    job_type: "claude",
    enabled: true,
    cron: "",
    group: "agent",
    slug,
    work_dir: folder,
  };
}

export default function JobDetailScreen() {
  const { name, run_id, demo } = useLocalSearchParams<{ name: string; run_id?: string; demo?: string }>();
  const storeJob = useJob(name);
  const isAgent = !storeJob && name.startsWith("agent-");
  const isDemo = demo === "1" || (!storeJob && !isAgent && isDemoJob(name));
  const demoJob = isDemo ? DEMO_JOBS.find((j) => j.name === name || j.slug === name) : undefined;
  const job = storeJob ?? (isAgent ? agentJobFromSlug(name) : demoJob);
  const slug = job?.slug ?? name;
  const realStatus = useJobStatus(name);
  const status = isDemo ? (DEMO_STATUSES[slug] ?? realStatus) : realStatus;
  const { logs } = useLogs(slug);
  const runs = useRunsStore((s) => s.runs[slug]) ?? null;
  const router = useRouter();
  const [runsLoading, setRunsLoading] = useState(false);
  const connected = useWsStore((s) => s.connected);

  const questions = useNotificationStore((s) => s.questions);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const enableAutoYes = useNotificationStore((s) => s.enableAutoYes);
  const disableAutoYes = useNotificationStore((s) => s.disableAutoYes);
  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const jobQuestion = questions.find((q) => q.matched_job === slug);
  const autoYesActive = jobQuestion ? autoYesPaneIds.has(jobQuestion.pane_id) : false;

  const loadRuns = useCallback(() => {
    if (isDemo) return;
    const send = getWsSend();
    if (!send || !name) return;
    const id = nextId();
    setRunsLoading(true);
    send({ type: "get_run_history", id, name: slug, limit: 50 });
    registerRequest<RunRecord[]>(id).then((result) => {
      useRunsStore.getState().setRuns(slug, result);
      setRunsLoading(false);
    });
  }, [slug, isDemo]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Reload runs when WebSocket reconnects (e.g. after page refresh)
  useEffect(() => {
    if (connected && !isDemo) {
      loadRuns();
    }
  }, [connected, isDemo]); // eslint-disable-line react-hooks/exhaustive-deps

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
              if (s) s({ type: "send_input", id: nextId(), name: slug, text: yesOpt });
              setTimeout(() => answerQuestion(jobQuestion.question_id), 1500);
            }
          },
        },
      ],
    );
  }, [jobQuestion, autoYesPaneIds, enableAutoYes, disableAutoYes, answerQuestion, slug]);

  const loaded = useJobsStore((s) => s.loaded);

  if (!job) {
    // If jobs haven't loaded yet (cold start from notification), show loading state
    const waiting = !loaded || !connected;
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "", headerLeft: () => <BackTitle title={name} /> }} />
        <View style={styles.center}>
          {waiting ? (
            <>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.loadingText}>
                {!connected ? "Connecting..." : "Loading..."}
              </Text>
            </>
          ) : (
            <Text style={styles.notFound}>Job not found</Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "",
          headerLeft: () => <BackTitle title={job.name} />,
          headerRight: () => <StatusBadge status={status} />,
        }}
      />
      {isDemo && <DemoBanner />}
      <ContentContainer wide>
        <JobDetailView
          transport={isDemo ? demoTransport : wsTransport}
          job={job}
          status={status}
          logs={isDemo ? (DEMO_LOGS[slug] ?? "") : logs}
          runs={isDemo ? (DEMO_RUNS[slug] ?? []) : runs}
          runsLoading={isDemo ? false : runsLoading}
          onBack={() => router.back()}
          showBackButton={false}
          onReloadRuns={isDemo ? undefined : loadRuns}
          expandRunId={run_id}
          options={isDemo ? undefined : jobQuestion?.options}
          questionContext={isDemo ? undefined : jobQuestion?.context_lines}
          autoYesActive={isDemo ? false : autoYesActive}
          onToggleAutoYes={isDemo ? undefined : (jobQuestion ? handleToggleAutoYes : undefined)}
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
  loadingText: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 8,
  },
});
