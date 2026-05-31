import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, View, Text, StyleSheet, KeyboardAvoidingView, Platform, Keyboard, TouchableOpacity } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { BackTitle } from "./_layout";
import { useJob, useJobStatus, useJobsStore } from "../../src/store/jobs";
import { useRunsStore } from "../../src/store/runs";
import { useNotificationStore } from "../../src/store/notifications";
import { useWsStore } from "../../src/store/ws";
import { StatusBadge, XtermLog } from "@clawtab/shared";
import type { XtermLogHandle } from "@clawtab/shared";
import { JobDetailView, findYesOption } from "@clawtab/shared";
import { ContentContainer } from "../../src/components/ContentContainer";
import { DemoBanner } from "../../src/components/DemoOverlay";
import { useLogs } from "../../src/hooks/useLogs";
import { usePty } from "../../src/hooks/usePty";
import { createWsTransport } from "../../src/transport/wsTransport";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { registerRequest } from "../../src/lib/useRequestMap";
import { DEMO_JOBS, DEMO_STATUSES, DEMO_LOGS, DEMO_RUNS, isDemoJob } from "../../src/demo/data";
import { colors } from "@clawtab/shared";
import type { Transport } from "@clawtab/shared";
import type { RemoteJob, RunRecord } from "@clawtab/shared";

const KEYBOARD_EXTRA_LIFT = 72;

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
  runAgent: async () => null,
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
  const [keyboardBuffer, setKeyboardBuffer] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardBuffer(KEYBOARD_EXTRA_LIFT));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardBuffer(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

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
  const statusPaneId = status?.state === "running" ? (status as any).pane_id ?? "" : "";
  const statusTmuxSession = status?.state === "running" ? (status as any).tmux_session ?? "" : "";
  const termRef = useRef<XtermLogHandle | null>(null);
  const { sendInput, sendResize, connecting: ptyConnecting } = usePty(statusPaneId, statusTmuxSession, termRef);
  const isRunningWithPty = !!statusPaneId && !!statusTmuxSession && !isDemo;

  const sendTmuxPaneKey = useCallback(
    (key: string) => {
      const send = getWsSend();
      if (!send || !statusPaneId) return;
      send({ type: "tmux_pane_key", pane_id: statusPaneId, key });
    },
    [statusPaneId],
  );

  const scrollTerminal = useCallback(
    (direction: "up" | "down") => {
      sendTmuxPaneKey("copy-mode");
      setTimeout(() => sendTmuxPaneKey(direction === "up" ? "C-u" : "C-d"), 30);
    },
    [sendTmuxPaneKey],
  );

  const renderTerminal = useCallback(
    () => (
      <KeyboardAvoidingView
        style={{ flex: 1, minHeight: 0 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={-KEYBOARD_EXTRA_LIFT}
      >
        <View style={[styles.ptyConnecting, !ptyConnecting && styles.ptyConnectingHidden]}>
          {ptyConnecting ? (
            <>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={styles.ptyConnectingText}>Connecting to terminal...</Text>
            </>
          ) : null}
        </View>
        <View style={styles.terminalFrame}>
          <TerminalScrollButtons
            onScrollUp={() => scrollTerminal("up")}
            onScrollDown={() => scrollTerminal("down")}
          />
          <XtermLog
            ref={termRef}
            onData={sendInput}
            onResize={sendResize}
            interactive
          />
        </View>
        {keyboardBuffer > 0 ? <View style={{ height: keyboardBuffer }} /> : null}
      </KeyboardAvoidingView>
    ),
    [sendInput, sendResize, ptyConnecting, keyboardBuffer, scrollTerminal],
  );

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
          renderTerminal={isRunningWithPty ? renderTerminal : undefined}
          hideMessageInput={isRunningWithPty}
        />
      </ContentContainer>
    </View>
  );
}

function TerminalScrollButtons({
  onScrollUp,
  onScrollDown,
}: {
  onScrollUp: () => void;
  onScrollDown: () => void;
}) {
  return (
    <View style={styles.scrollControls} pointerEvents="box-none">
      <TouchableOpacity style={styles.scrollBtn} onPress={onScrollUp} activeOpacity={0.7}>
        <Ionicons name="chevron-up" size={18} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.scrollBtn} onPress={onScrollDown} activeOpacity={0.7}>
        <Ionicons name="chevron-down" size={18} color={colors.text} />
      </TouchableOpacity>
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
  ptyConnecting: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ptyConnectingHidden: {
    height: 0,
    paddingVertical: 0,
    borderBottomWidth: 0,
    overflow: "hidden",
  },
  ptyConnectingText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  terminalFrame: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  scrollControls: {
    position: "absolute",
    top: 8,
    right: 8,
    zIndex: 20,
    gap: 6,
  },
  scrollBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(28, 28, 30, 0.82)",
  },
});
