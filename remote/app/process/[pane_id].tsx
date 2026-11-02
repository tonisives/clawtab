import { ShellSurface } from "../../src/components/ShellSurface";
import { toggleAutoYes } from "../../src/lib/autoYes"
import { useAgentActions } from "../../src/hooks/useAgentActions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, View, TouchableOpacity, StyleSheet } from "react-native";
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useJobsStore } from "../../src/store/jobs";
import { usePinsStore } from "../../src/store/pins";
import { useNotificationStore } from "../../src/store/notifications";
import { JobKindIcon, OptionButtons, PaneOverviewModal, compactPath, findYesOption, kindForProcess, colors, radius } from "@clawtab/shared";
import { useMachineStatus } from "../../src/hooks/useMachineStatus";
import { getWsSend, nextId } from "../../src/lib/wsRuntime";
import { stopSession } from "../../src/lib/stopSession";
import { HeaderTitleWithIcon } from "../../src/components/HeaderButtons";
import { LoadingBar } from "../../src/components/LoadingBar";
import { useDetailBack } from "../../src/hooks/useDetailBack";
import { useResponsive } from "../../src/hooks/useResponsive";
import { alertError, confirm } from "../../src/lib/platform";
import { jobRoute } from "../../src/lib/notificationRoutes";
import { useLandscapeTerminalHeader } from "../../src/hooks/useLandscapeTerminalHeader";
import { TerminalHeaderActions } from "../../src/components/TerminalHeaderActions";
import { LandscapeTerminalBar } from "../../src/components/LandscapeTerminalBar";
import { useLandscapeShellNavigation } from "../../src/hooks/useLandscapeShellNavigation";



export default function ProcessDetailScreen() {
  const { pane_id: rawPaneId, source, fromSplit, landscapeHandoff } = useLocalSearchParams<{ pane_id: string; source?: string; fromSplit?: string; landscapeHandoff?: string }>();
  let routePaneId = (rawPaneId ?? "").replace(/_pct_/g, "%");
  return (
    <ProcessDetailContent
      key={routePaneId}
      pane_id={routePaneId}
      preserveTerminal={source === "notifications"}
      fromSplit={fromSplit === "1" || landscapeHandoff === "1"}
      landscapeHandoff={landscapeHandoff === "1"}
    />
  );
}

type ProcessDetailContentProps = {
  pane_id: string;
  preserveTerminal: boolean;
  fromSplit: boolean;
  landscapeHandoff: boolean;
};

let ProcessDetailContent = ({ pane_id, preserveTerminal, fromSplit, landscapeHandoff }: ProcessDetailContentProps) => {
  const router = useRouter();
  const goBack = useDetailBack("/(tabs)");
  const insets = useSafeAreaInsets();
  const { isWide } = useResponsive();
  const landscapeHeader = useLandscapeTerminalHeader(true);
  const showLandscapeSidebar = useLandscapeShellNavigation({ kind: "process", paneId: pane_id }, fromSplit);
  const containerStyle = landscapeHeader.isLandscape
    ? [styles.container, { paddingLeft: insets.left, paddingRight: insets.right }]
    : styles.container;

  const storeProcess = useJobsStore((s) =>
    s.detectedProcesses.find((p) => p.pane_id === pane_id),
  );
  const process = storeProcess;

  // If this pane belongs to a tracked job (not in detectedProcesses), redirect
  // to the job detail page instead.
  const jobs = useJobsStore((s) => s.jobs);
  const statuses = useJobsStore((s) => s.statuses);
  const questions = useNotificationStore((s) => s.questions);
  useEffect(() => {
    if (process || preserveTerminal) return; // notification details stay on the terminal route
    const paneQuestions = questions.filter((q) => q.pane_id === pane_id);
    for (const q of paneQuestions) {
      if (q.matched_job) {
        router.replace(jobRoute(q.matched_job));
        return;
      }
      for (const job of jobs) {
        if (statuses[job.name]?.state !== "running") continue;
        const dir = job.work_dir || job.path;
        if (dir && (q.cwd === dir || q.cwd.startsWith(dir + "/"))) {
          router.replace(jobRoute(job.name));
          return;
        }
      }
      if (q.matched_group) {
        for (const job of jobs) {
          if (statuses[job.name]?.state !== "running") continue;
          if (job.group === q.matched_group) {
            router.replace(jobRoute(job.name));
            return;
          }
        }
      }
    }
  }, [process, pane_id, preserveTerminal, questions, jobs, statuses, router]);

  let { connected, online: desktopOnline } = useMachineStatus(pane_id);
  const loaded = useJobsStore((s) => s.loaded);

  // Cold start from notification: waiting for relay data
  const waitingForData = !preserveTerminal && !process && !questions.some((q) => q.pane_id === pane_id) && (!connected || !desktopOnline || !loaded);

  const lastProcessRef = useRef(process);
  if (process) lastProcessRef.current = process;
  const lastProcess = lastProcessRef.current;
  const [stopping, setStopping] = useState(false);
  let [stopError, setStopError] = useState<string | null>(null);
  const pinnedItems = usePinsStore((s) => s.pinnedItems);
  const hydratePins = usePinsStore((s) => s.hydrate);
  const togglePin = usePinsStore((s) => s.togglePin);
  const pinKey = `pane:${pane_id}`;
  const isPinned = pinnedItems.includes(pinKey);
  const handleTogglePin = useCallback(() => {
    togglePin(pinKey);
  }, [pinKey, togglePin]);

  // Derive tmux info from process or question (for panes not in detectedProcesses)
  const paneQuestion = questions.find((q) => q.pane_id === pane_id);
  let lastQuestionRef = useRef(paneQuestion);
  if (paneQuestion) lastQuestionRef.current = paneQuestion;
  let questionInfo = paneQuestion ?? lastQuestionRef.current;
  const tmuxSession = (process ?? lastProcess)?.tmux_session ?? questionInfo?.tmux_session ?? "";

  const activeProcess = process ?? lastProcess;
  const displayName = activeProcess
    ? activeProcess.cwd.replace(/^\/Users\/[^/]+/, "~")
    : questionInfo?.cwd.replace(/^\/Users\/[^/]+/, "~") ?? pane_id;
  const headerTitle = activeProcess
    ? compactPath(activeProcess.cwd)
    : questionInfo?.cwd
      ? compactPath(questionInfo.cwd)
      : pane_id;
  const headerKind = activeProcess ? kindForProcess(activeProcess) : "claude";
  const [showPaneOverview, setShowPaneOverview] = useState(false);
  let agentActionControls = useAgentActions(pane_id, showPaneOverview);

  useEffect(() => {
    hydratePins();
  }, [hydratePins]);

  const options = paneQuestion?.options ?? [];
  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const autoYesActive = autoYesPaneIds.has(pane_id);

  const handleToggleAutoYes = useCallback(() => {
    if (!pane_id) return
    toggleAutoYes(pane_id, displayName, () => {
      let yesOpt = paneQuestion ? findYesOption(paneQuestion) : undefined
      let send = getWsSend()
      if (!yesOpt || !send) return
      send({ type: "send_detected_process_input", id: nextId(), pane_id, text: yesOpt })
      if (paneQuestion) setTimeout(() => answerQuestion(paneQuestion.question_id), 1500)
    })
  }, [pane_id, displayName, paneQuestion, answerQuestion])

  const handleSend = useCallback(
    (text: string) => {
      const send = getWsSend();
      if (!send || !text.trim()) return;

      send({
        type: "send_detected_process_input",
        id: nextId(),
        pane_id,
        text: text.trim(),
      });
      // Dismiss notification card if we just answered a question
      if (paneQuestion) {
        answerQuestion(paneQuestion.question_id);
      }
    },
    [pane_id, paneQuestion, answerQuestion],
  );

  const doStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await stopSession(pane_id);
      setShowPaneOverview(false);
      useJobsStore.getState().removeDetectedProcess(pane_id);
      if (router.canGoBack()) router.back();
      else router.replace("/(tabs)");
    } catch (error) {
      let message = error instanceof Error ? error.message : "Please try again.";
      setStopError(message);
      if (Platform.OS === "web") alertError("Could not stop session", message);
    } finally {
      setStopping(false);
    }
  }, [pane_id, router, stopping]);

  const handleStop = useCallback(() => {
    confirm("Stop session", `Close the terminal session in ${displayName} and stop any program running in it?`, doStop);
  }, [displayName, doStop]);

  const openPaneOverview = useCallback(() => setShowPaneOverview(true), []);
  const waitingHeaderOptions = useMemo(() => ({
    animation: landscapeHandoff ? "none" as const : "slide_from_right" as const,
    orientation: Platform.OS === "ios" && !Platform.isPad ? "default" as const : undefined,
    headerShown: !isWide && landscapeHeader.headerShown,
    title: pane_id,
    headerStyle: { backgroundColor: colors.bg },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: "600" as const },
    headerBackTitle: "",
    headerBackButtonDisplayMode: "minimal" as const,
  }), [isWide, landscapeHeader.headerShown, pane_id, landscapeHandoff]);
  const terminalHeaderOptions = useMemo(() => ({
    animation: landscapeHandoff ? "none" as const : "slide_from_right" as const,
    orientation: Platform.OS === "ios" && !Platform.isPad ? "default" as const : undefined,
    headerShown: !isWide && landscapeHeader.headerShown,
    headerStyle: { backgroundColor: colors.bg },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: "600" as const },
    headerBackTitle: "",
    headerBackButtonDisplayMode: "minimal" as const,
    headerTitle: () => (
      <HeaderTitleWithIcon
        title={headerTitle}
        icon={<JobKindIcon kind={headerKind} size={26} bare />}
        onPress={openPaneOverview}
        accessibilityLabel="Open pane overview"
      />
    ),
    headerRight: () => (
      <View style={styles.headerActions}>
        <TouchableOpacity
          style={styles.contextBtn}
          onPress={openPaneOverview}
          activeOpacity={0.6}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open pane overview"
        >
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>
    ),
  }), [headerKind, headerTitle, isWide, landscapeHeader.headerShown, openPaneOverview, landscapeHandoff]);

  const isAlive = !!process || !!paneQuestion;
  if (waitingForData) {
    const loading = processLoadingState({ connected, desktopOnline, hasTmuxSession: !!tmuxSession });
    return (
      <View style={containerStyle}>
        <Stack.Screen options={waitingHeaderOptions} />
        <View style={styles.center}>
          <LoadingBar label={loading.label} progress={loading.progress} />
        </View>
      </View>
    );
  }

  return (
    <View style={containerStyle}>
      <Stack.Screen options={terminalHeaderOptions} />
      <ShellSurface paneId={pane_id} onScrollGesture={landscapeHeader.onScrollGesture} />
      {landscapeHeader.overlayShown ? (
        <LandscapeTerminalBar
          topInset={insets.top}
          leftInset={insets.left}
          rightInset={insets.right}
          onBack={showLandscapeSidebar}
          title={<HeaderTitleWithIcon title={headerTitle} icon={<JobKindIcon kind={headerKind} size={26} bare />} onPress={openPaneOverview} accessibilityLabel="Open pane overview" />}
          actions={<TerminalHeaderActions onZoom={showLandscapeSidebar} zoomed onOpenDetails={openPaneOverview} />}
        />
      ) : null}
      {(isAlive || paneQuestion) && (
        <OptionButtons
          options={options}
          onSend={handleSend}
          bottomInset={insets.bottom}
        />
      )}
      <PaneOverviewModal
        visible={showPaneOverview}
        onClose={() => setShowPaneOverview(false)}
        paneId={pane_id}
        startedAt={activeProcess?.session_started_at}
        cwd={activeProcess?.cwd ?? questionInfo?.cwd}
        tmuxSession={tmuxSession}
        windowName={activeProcess?.window_name || questionInfo?.window_name}
        firstQuery={activeProcess?.first_query}
        lastQuery={activeProcess?.last_query}
        actions={{
          ...agentActionControls,
          autoYesActive,
          onToggleAutoYes: handleToggleAutoYes,
          isPinned,
          onTogglePin: handleTogglePin,
          onStop: Platform.OS === "web" ? handleStop : doStop,
          stopping,
          stopError,
        }}
      />
    </View>
  );
}

function processLoadingState({
  connected,
  desktopOnline,
  hasTmuxSession,
  waitingForAgent = false,
}: {
  connected: boolean;
  desktopOnline: boolean;
  hasTmuxSession: boolean;
  waitingForAgent?: boolean;
}) {
  if (!connected) return { label: "Connecting to relay...", progress: 0.28 };
  if (!desktopOnline) return { label: "Connecting to desktop...", progress: 0.55 };
  if (!hasTmuxSession) return { label: "Loading agent session...", progress: 0.72 };
  if (waitingForAgent) return { label: "Loading terminal output...", progress: 0.88 };
  return { label: "Connected", progress: 1 };
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  headerActions: { flexDirection: "row", alignItems: "center" },
  contextBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
});
