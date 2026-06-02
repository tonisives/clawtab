import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, View, Text, StyleSheet, Platform, Keyboard, TouchableOpacity, TextInput } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useJob, useJobStatus, useJobsStore } from "../../src/store/jobs";
import { useRunsStore } from "../../src/store/runs";
import { useNotificationStore } from "../../src/store/notifications";
import { useWsStore } from "../../src/store/ws";
import { JobKindIcon, XtermLog, kindForJob, statusColor } from "@clawtab/shared";
import type { XtermLogHandle } from "@clawtab/shared";
import { JobDetailView, findYesOption } from "@clawtab/shared";
import { ContentContainer } from "../../src/components/ContentContainer";
import { DemoBanner } from "../../src/components/DemoOverlay";
import { useLogs } from "../../src/hooks/useLogs";
import { usePty } from "../../src/hooks/usePty";
import { createWsTransport } from "../../src/transport/wsTransport";
import { getWsSend, nextId } from "../../src/lib/wsRuntime";
import { registerRequest } from "../../src/lib/useRequestMap";
import { DEMO_JOBS, DEMO_STATUSES, DEMO_LOGS, DEMO_RUNS, isDemoJob } from "../../src/demo/data";
import { HeaderBackButton, HeaderStatusDot, HeaderTitleWithIcon } from "../../src/components/HeaderButtons";
import { colors } from "@clawtab/shared";
import type { Transport } from "@clawtab/shared";
import type { RemoteJob, RunRecord } from "@clawtab/shared";

const KEYBOARD_EXTRA_CLEARANCE = 18;
const KEYBOARD_TOOLBAR_HEIGHT = 48;
const TERMINAL_BG = "#1c1c1e";

function encodeTerminalInput(text: string): string {
  if (typeof btoa === "function") return btoa(text);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i) & 0xff;
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) & 0xff : 0;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) & 0xff : 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += chars[(triplet >> 18) & 63];
    output += chars[(triplet >> 12) & 63];
    output += i + 1 < text.length ? chars[(triplet >> 6) & 63] : "=";
    output += i + 2 < text.length ? chars[triplet & 63] : "=";
  }
  return output;
}

const wsTransport = createWsTransport();

const noop = async () => {};
const noopRunJob = async () => null;
const demoTransport: Transport = {
  listJobs: async () => ({ jobs: [], statuses: {} }),
  getStatuses: async () => ({}),
  runJob: noopRunJob,
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
  const insets = useSafeAreaInsets();
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
  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  }, [router]);

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
  const keyboardDismissRef = useRef<TextInput | null>(null);
  const { sendInput, sendResize, connecting: ptyConnecting } = usePty(statusPaneId, statusTmuxSession, termRef);
  const isRunningWithPty = !!statusPaneId && !!statusTmuxSession && !isDemo;
  const [copyModeActive, setCopyModeActive] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const show = Keyboard.addListener("keyboardWillShow", (event) => {
      const keyboardHeight = event.endCoordinates?.height ?? 0;
      setKeyboardVisible(true);
      setKeyboardHeight(keyboardHeight);
      termRef.current?.setVisualOffset(Math.max(0, keyboardHeight + KEYBOARD_TOOLBAR_HEIGHT + KEYBOARD_EXTRA_CLEARANCE));
    });
    const hide = Keyboard.addListener("keyboardWillHide", () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
      termRef.current?.setVisualOffset(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

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
      setCopyModeActive(true);
      sendTmuxPaneKey(direction === "up" ? "copy-halfpage-up" : "copy-halfpage-down");
    },
    [sendTmuxPaneKey],
  );

  const exitCopyMode = useCallback(() => {
    setCopyModeActive(false);
    sendTmuxPaneKey("copy-cancel");
  }, [sendTmuxPaneKey]);

  const sendTerminalText = useCallback(
    (text: string) => {
      sendInput(encodeTerminalInput(text));
    },
    [sendInput],
  );

  const dismissTerminalKeyboard = useCallback(() => {
    termRef.current?.blur();
    keyboardDismissRef.current?.focus();
    setTimeout(() => {
      keyboardDismissRef.current?.blur();
      Keyboard.dismiss();
    }, 30);
  }, []);

  const renderTerminal = useCallback(
    () => (
      <View style={{ flex: 1, minHeight: 0 }}>
        <View style={[styles.ptyConnecting, !ptyConnecting && styles.ptyConnectingHidden]}>
          {ptyConnecting ? (
            <>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={styles.ptyConnectingText}>Connecting to terminal...</Text>
            </>
          ) : null}
        </View>
        <View style={[styles.terminalFrame, { paddingBottom: Math.max(12, insets.bottom + 8) }]}>
          <XtermLog
            ref={termRef}
            onData={sendInput}
            onResize={sendResize}
            interactive
          />
          {!ptyConnecting ? (
            <TerminalScrollButtons
              onScrollUp={() => scrollTerminal("up")}
              onScrollDown={() => scrollTerminal("down")}
              onExitCopyMode={exitCopyMode}
              copyModeActive={copyModeActive}
            />
          ) : null}
        </View>
      </View>
    ),
    [sendInput, sendResize, ptyConnecting, scrollTerminal, exitCopyMode, copyModeActive, insets.bottom],
  );

  if (!job) {
    // If jobs haven't loaded yet (cold start from notification), show loading state
    const waiting = !loaded || !connected;
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: name }} />
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
          headerLeft: () => <HeaderBackButton onPress={handleBack} />,
          headerTitle: () => (
            <HeaderTitleWithIcon
              title={job.name}
              icon={<JobKindIcon kind={kindForJob(job)} size={26} bare />}
            />
          ),
          headerRight: () => <HeaderStatusDot color={statusColor(status)} />,
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
          optionBarBottomInset={insets.bottom}
        />
      </ContentContainer>
      {keyboardVisible && isRunningWithPty ? (
        <TerminalKeyboardToolbar
          bottom={keyboardHeight}
          onDismiss={dismissTerminalKeyboard}
          onEscape={() => sendTerminalText("\x1b")}
          onArrowUp={() => sendTerminalText("\x1b[A")}
          onArrowDown={() => sendTerminalText("\x1b[B")}
          onArrowLeft={() => sendTerminalText("\x1b[D")}
          onArrowRight={() => sendTerminalText("\x1b[C")}
          onCtrlC={() => sendTerminalText("\x03")}
        />
      ) : null}
      <TextInput
        ref={keyboardDismissRef}
        style={styles.keyboardDismissSink}
        showSoftInputOnFocus={false}
        caretHidden
        autoCorrect={false}
        autoCapitalize="none"
      />
    </View>
  );
}

function TerminalKeyboardToolbar({
  bottom,
  onDismiss,
  onEscape,
  onArrowUp,
  onArrowDown,
  onArrowLeft,
  onArrowRight,
  onCtrlC,
}: {
  bottom: number;
  onDismiss: () => void;
  onEscape: () => void;
  onArrowUp: () => void;
  onArrowDown: () => void;
  onArrowLeft: () => void;
  onArrowRight: () => void;
  onCtrlC: () => void;
}) {
  return (
    <View style={[styles.keyboardToolbar, { bottom }]}>
      <TouchableOpacity style={styles.keyboardToolBtn} onPress={onDismiss} activeOpacity={0.7}>
        <Ionicons name="close" size={20} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.keyboardToolBtnWide} onPress={onEscape} activeOpacity={0.7}>
        <Text style={styles.keyboardToolText}>Esc</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.keyboardToolBtnWide} onPress={onCtrlC} activeOpacity={0.7}>
        <Text style={styles.keyboardToolText}>C-c</Text>
      </TouchableOpacity>
      <View style={styles.keyboardToolSpacer} />
      <TouchableOpacity style={styles.keyboardToolBtn} onPress={onArrowLeft} activeOpacity={0.7}>
        <Ionicons name="chevron-back" size={20} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.keyboardToolBtn} onPress={onArrowDown} activeOpacity={0.7}>
        <Ionicons name="chevron-down" size={20} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.keyboardToolBtn} onPress={onArrowUp} activeOpacity={0.7}>
        <Ionicons name="chevron-up" size={20} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.keyboardToolBtn} onPress={onArrowRight} activeOpacity={0.7}>
        <Ionicons name="chevron-forward" size={20} color={colors.text} />
      </TouchableOpacity>
    </View>
  );
}

function TerminalScrollButtons({
  onScrollUp,
  onScrollDown,
  onExitCopyMode,
  copyModeActive,
}: {
  onScrollUp: () => void;
  onScrollDown: () => void;
  onExitCopyMode: () => void;
  copyModeActive: boolean;
}) {
  return (
    <View style={styles.scrollControls} pointerEvents="box-none">
      <TouchableOpacity style={styles.scrollBtn} onPress={onScrollUp} activeOpacity={0.7}>
        <View style={styles.scrollBtnVisible}>
          <Ionicons name="chevron-up" size={24} color={colors.text} />
        </View>
      </TouchableOpacity>
      <TouchableOpacity style={styles.scrollBtn} onPress={onScrollDown} activeOpacity={0.7}>
        <View style={styles.scrollBtnVisible}>
          <Ionicons name="chevron-down" size={24} color={colors.text} />
        </View>
      </TouchableOpacity>
      {copyModeActive ? (
        <TouchableOpacity style={styles.exitCopyBtn} onPress={onExitCopyMode} activeOpacity={0.7}>
          <View style={styles.scrollBtnVisible}>
            <Ionicons name="close" size={24} color={colors.text} />
          </View>
        </TouchableOpacity>
      ) : null}
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
    backgroundColor: TERMINAL_BG,
  },
  keyboardToolbar: {
    position: "absolute",
    left: 0,
    right: 0,
    height: KEYBOARD_TOOLBAR_HEIGHT,
    zIndex: 200,
    elevation: 200,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  keyboardToolBtn: {
    width: 38,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  keyboardToolBtnWide: {
    minWidth: 48,
    height: 34,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  keyboardToolText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  keyboardToolSpacer: {
    flex: 1,
  },
  keyboardDismissSink: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    left: -10,
    bottom: 0,
  },
  scrollControls: {
    position: "absolute",
    top: 8,
    right: 8,
    zIndex: 100,
    elevation: 100,
    gap: 4,
  },
  scrollBtn: {
    width: 64,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  exitCopyBtn: {
    position: "absolute",
    left: -8,
    top: "50%",
    transform: [{ translateX: -64 }, { translateY: -32 }],
    width: 64,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  scrollBtnVisible: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(28, 28, 30, 0.82)",
  },
});
