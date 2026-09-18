import { NextNotification } from "../../src/components/NextNotification";
import { notificationProcessRoute } from "../../src/lib/notificationRoutes";
import type { ClaudeQuestion } from "@clawtab/shared";
import { MachineTerminalControls } from "@clawtab/shared";
import { useAgentActions } from "../../src/hooks/useAgentActions";
import { encodeTerminalInput } from "@clawtab/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, View, Text, StyleSheet, Platform, Keyboard, TouchableOpacity, TextInput } from "react-native";
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { TerminalPasteButton } from "../../src/components/TerminalPasteButton";
import { TerminalWriteDialog } from "../../src/components/TerminalWriteDialog";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useJob, useJobStatus, useJobsStore } from "../../src/store/jobs";
import { useRunsStore } from "../../src/store/runs";
import { useNotificationStore } from "../../src/store/notifications";
import { useWsStore } from "../../src/store/ws";
import { JobKindIcon, XtermLog, TERMINAL_FONT_SIZE, kindForJob, statusColor } from "@clawtab/shared";
import type { XtermLogHandle } from "@clawtab/shared";
import { JobDetailView, findYesOption } from "@clawtab/shared";
import type { AgentModelOption, JobUpdate, ProcessProvider } from "@clawtab/shared";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useLogs } from "../../src/hooks/useLogs";
import { usePty } from "../../src/hooks/usePty";
import { createWsTransport } from "../../src/transport/wsTransport";
import { getWsSend, nextId } from "../../src/lib/wsRuntime";
import { registerRequest } from "../../src/lib/useRequestMap";
import { HeaderStatusDot, HeaderTitleWithIcon } from "../../src/components/HeaderButtons";
import { useDetailBack } from "../../src/hooks/useDetailBack";
import { useResponsive } from "../../src/hooks/useResponsive";
import { useTerminalKeyboard } from "../../src/hooks/useTerminalKeyboard";
import { TerminalCopySheet } from "../../src/components/TerminalCopySheet";
import { colors } from "@clawtab/shared";
import { useLandscapeTerminalHeader } from "../../src/hooks/useLandscapeTerminalHeader";
import { TerminalZoomControls } from "../../src/components/TerminalZoomControls";
import type { RemoteJob, RunRecord } from "@clawtab/shared";
import { buildModelOptions } from "../../src/lib/agentModels";

const KEYBOARD_EXTRA_CLEARANCE = 10;
const KEYBOARD_TOOLBAR_HEIGHT = 48;
const TERMINAL_BG = "#1c1c1e";
const AGENT_PROVIDERS: ProcessProvider[] = ["claude", "codex", "opencode", "antigravity"];


const wsTransport = createWsTransport();


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
  const { name, run_id, source } = useLocalSearchParams<{ name: string; run_id?: string; source?: string }>();
  let router = useRouter();
  let handleSelectNotification = (question: ClaudeQuestion) => {
    Keyboard.dismiss();
    router.replace(notificationProcessRoute(question.pane_id));
  };
  const insets = useSafeAreaInsets();
  const { isWide } = useResponsive();
  const storeJob = useJob(name);
  const defaultAgentProvider = useJobsStore((s) => s.defaultProvider);
  const defaultAgentModel = useJobsStore((s) => s.defaultModel);
  const enabledModels = useJobsStore((s) => s.enabledModels);
  const isAgent = !storeJob && name.startsWith("agent-");
  const job = storeJob ?? (isAgent ? agentJobFromSlug(name) : undefined);
  const slug = job?.slug ?? name;
  const modelOptions: AgentModelOption[] = buildModelOptions(AGENT_PROVIDERS, enabledModels ?? {});
  const onUpdateJob = useCallback(async (patch: JobUpdate) => {
    if (wsTransport.updateJob) await wsTransport.updateJob(slug, patch);
  }, [slug]);
  const realStatus = useJobStatus(name);
  const status = realStatus;
  const statusPaneId = status?.state === "running" ? (status as any).pane_id ?? "" : "";
  let [showPaneOverview, setShowPaneOverview] = useState(false);
  let agentActionControls = useAgentActions(statusPaneId, showPaneOverview);
  let activeProcess = useJobsStore((state) => state.detectedProcesses.find((process) => process.pane_id === statusPaneId));
  const { logs } = useLogs(slug);
  const runs = useRunsStore((s) => s.runs[slug]) ?? null;
  const goBack = useDetailBack("/(tabs)");
  const [runsLoading, setRunsLoading] = useState(false);
  const connected = useWsStore((s) => s.connected);
  const questions = useNotificationStore((s) => s.questions);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const enableAutoYes = useNotificationStore((s) => s.enableAutoYes);
  const disableAutoYes = useNotificationStore((s) => s.disableAutoYes);
  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const jobQuestion = questions.find((q) => q.matched_job === slug);
  const autoYesPaneId = jobQuestion?.pane_id ?? statusPaneId;
  const autoYesActive = !!autoYesPaneId && autoYesPaneIds.has(autoYesPaneId);

  const loadRuns = useCallback(() => {
    const send = getWsSend();
    if (!send || !name) return;
    const id = nextId();
    setRunsLoading(true);
    send({ type: "get_run_history", id, name: slug, limit: 50 });
    registerRequest<RunRecord[]>(id).then((result) => {
      useRunsStore.getState().setRuns(slug, result);
      setRunsLoading(false);
    });
  }, [slug]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Reload runs when WebSocket reconnects (e.g. after page refresh)
  useEffect(() => {
    if (connected) {
      loadRuns();
    }
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleAutoYes = useCallback(() => {
    if (!autoYesPaneId) return;
    if (autoYesPaneIds.has(autoYesPaneId)) {
      disableAutoYes(autoYesPaneId);
      const send = getWsSend();
      if (send) {
        const next = new Set(autoYesPaneIds);
        next.delete(autoYesPaneId);
        send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] });
      }
      return;
    }
    const title = jobQuestion?.matched_job ?? jobQuestion?.cwd.replace(/^\/Users\/[^/]+/, "~") ?? slug;
    Alert.alert(
      "Enable auto-yes?",
      `All future questions for "${title}" will be automatically accepted with "Yes". This stays active until you disable it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Enable",
          style: "destructive",
          onPress: () => {
            enableAutoYes(autoYesPaneId);
            const send = getWsSend();
            if (send) {
              const next = new Set(autoYesPaneIds);
              next.add(autoYesPaneId);
              send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] });
            }
            const yesOpt = jobQuestion ? findYesOption(jobQuestion) : undefined;
            if (yesOpt) {
              const s = getWsSend();
              if (s) s({ type: "send_input", id: nextId(), name: slug, text: yesOpt });
              if (jobQuestion) setTimeout(() => answerQuestion(jobQuestion.question_id), 1500);
            }
          },
        },
      ],
    );
  }, [autoYesPaneId, jobQuestion, autoYesPaneIds, enableAutoYes, disableAutoYes, answerQuestion, slug]);

  const loaded = useJobsStore((s) => s.loaded);
  const statusTmuxSession = status?.state === "running" ? (status as any).tmux_session ?? "" : "";
  const termRef = useRef<XtermLogHandle | null>(null);
  const keyboardDismissRef = useRef<TextInput | null>(null);
  const {
    sendInput,
    sendResize,
    connecting: ptyConnecting,
    error: ptyError,
  } = usePty(statusPaneId, statusTmuxSession, termRef);
  const isRunningWithPty = !!statusPaneId && !!statusTmuxSession;
  const landscapeHeader = useLandscapeTerminalHeader(isRunningWithPty);
  const [terminalFontSize, setTerminalFontSize] = useState(TERMINAL_FONT_SIZE);
  const containerStyle = landscapeHeader.isLandscape && isRunningWithPty
    ? [styles.container, { paddingLeft: insets.left, paddingRight: insets.right }]
    : styles.container;
  const [copyModeActive, setCopyModeActive] = useState(false);
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const [writeDraft, setWriteDraft] = useState("");
  const [copyText, setCopyText] = useState<string | null>(null);
  const [optionOverlayHeight, setOptionOverlayHeight] = useState(0);
  useEffect(() => {
    if (!jobQuestion?.options?.length) setOptionOverlayHeight(0);
  }, [jobQuestion?.options?.length]);
  const {
    keyboardVisible,
    keyboardHeight,
    terminalSurfaceRef,
    handleTerminalLayout,
  } = useTerminalKeyboard({
    termRef,
    menuOpen: terminalMenuOpen,
    toolbarHeight: KEYBOARD_TOOLBAR_HEIGHT,
    extraClearance: KEYBOARD_EXTRA_CLEARANCE,
    overlayHeight: optionOverlayHeight,
  });

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
      if (!text) return;
      sendInput(encodeTerminalInput(text));
    },
    [sendInput],
  );

  const handleTerminalMenuOpenChange = useCallback((open: boolean) => {
    setTerminalMenuOpen(open);
    if (open) {
      setTimeout(() => termRef.current?.focus(), 0);
      setTimeout(() => termRef.current?.focus(), 80);
    }
  }, []);



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
        <View style={[styles.ptyConnecting, !ptyConnecting && !ptyError && styles.ptyConnectingHidden]}>
          {ptyConnecting || ptyError ? (
            <>
              {ptyConnecting ? <ActivityIndicator size="small" color={colors.accent} /> : null}
              <Text style={styles.ptyConnectingText}>
                {ptyError ?? "Connecting to terminal..."}
              </Text>
            </>
          ) : null}
        </View>
        <View style={[styles.terminalFrame, { paddingBottom: Math.max(12, insets.bottom + 8) }]}>
          <View ref={terminalSurfaceRef} style={styles.terminalSurface} onLayout={handleTerminalLayout}>
            {Platform.OS !== "ios" && <MachineTerminalControls paneId={statusPaneId ?? ""} />}
            <XtermLog
              ref={termRef}
              onData={sendInput}
              onResize={sendResize}
              interactive
              forceDarkTheme
              extendedViewport
              fontSize={terminalFontSize}
              onScrollGesture={landscapeHeader.onScrollGesture}
              onLongPressCopyText={setCopyText}
            />
          </View>
          {!ptyConnecting && !ptyError ? (
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
    [sendInput, sendResize, ptyConnecting, ptyError, scrollTerminal, exitCopyMode, copyModeActive, insets.bottom, handleTerminalLayout, terminalFontSize, landscapeHeader.onScrollGesture],
  );
  const loadingHeaderOptions = useMemo(() => ({
    headerShown: !isWide && landscapeHeader.headerShown,
    title: name,
    headerStyle: { backgroundColor: colors.bg },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: "600" as const },
    headerBackTitle: "",
    headerBackButtonDisplayMode: "minimal" as const,
  }), [isWide, landscapeHeader.headerShown, name]);
  const jobHeaderName = job?.name ?? name;
  const jobHeaderKind = job ? kindForJob(job) : "claude";
  const jobHeaderOptions = useMemo(() => ({
    orientation: Platform.OS === "ios" && !Platform.isPad
      ? isRunningWithPty ? "default" as const : "portrait_up" as const
      : undefined,
    headerShown: !isWide && landscapeHeader.headerShown,
    headerStyle: { backgroundColor: colors.bg },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: "600" as const },
    headerBackTitle: "",
    headerBackButtonDisplayMode: "minimal" as const,
    headerTitle: () => (
      <HeaderTitleWithIcon
        title={jobHeaderName}
        icon={<JobKindIcon kind={jobHeaderKind} size={26} bare />}
      />
    ),
    headerRight: () => (
      <View style={styles.headerActions}>
        {Platform.OS === "ios" && isRunningWithPty ? <TerminalZoomControls fontSize={terminalFontSize} onChange={setTerminalFontSize} /> : null}
        <HeaderStatusDot
          color={autoYesActive ? colors.warning : statusColor(status)}
          onPress={!autoYesPaneId ? undefined : handleToggleAutoYes}
          accessibilityLabel={!autoYesPaneId ? "Status" : autoYesActive ? "Disable auto-yes" : "Enable auto-yes"}
        />
      </View>
    ),
  }), [autoYesActive, autoYesPaneId, handleToggleAutoYes, isWide, landscapeHeader.headerShown, jobHeaderKind, jobHeaderName, status, isRunningWithPty, terminalFontSize]);
  if (!job) {
    // If jobs haven't loaded yet (cold start from notification), show loading state
    const waiting = !loaded || !connected;
    return (
      <View style={containerStyle}>
        <Stack.Screen options={loadingHeaderOptions} />
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
    <View style={containerStyle}>
      <Stack.Screen options={jobHeaderOptions} />

      <ContentContainer wide fill>
        <JobDetailView
          transport={wsTransport}
          job={job}
          status={status}
          logs={logs}
          runs={runs}
          runsLoading={runsLoading}
          onBack={goBack}
          showBackButton={false}
          onReloadRuns={loadRuns}
          expandRunId={run_id}
          options={jobQuestion?.options}
          questionContext={jobQuestion?.context_lines}
          autoYesActive={autoYesActive}
          onToggleAutoYes={!autoYesPaneId ? undefined : handleToggleAutoYes}
          renderTerminal={isRunningWithPty ? renderTerminal : undefined}
          hideMessageInput={isRunningWithPty}
          expandOutput={isRunningWithPty}
          paneOverview={statusPaneId ? { paneId: statusPaneId, tmuxSession: activeProcess?.tmux_session, windowName: activeProcess?.window_name, cwd: activeProcess?.cwd ?? job.work_dir, startedAt: activeProcess?.session_started_at, firstQuery: activeProcess?.first_query, lastQuery: activeProcess?.last_query } : undefined}
          paneOverviewActions={agentActionControls}
          paneOverviewVisible={showPaneOverview}
          onPaneOverviewVisibleChange={setShowPaneOverview}
          defaultOutputCollapsed
          defaultRunsCollapsed
          defaultAgentProvider={(defaultAgentProvider ?? undefined) as import("@clawtab/shared").ProcessProvider | undefined}
          defaultAgentModel={defaultAgentModel}
          agentModelOptions={modelOptions}
          onUpdateJob={!isAgent ? onUpdateJob : undefined}
          optionBarBottomInset={insets.bottom}
          onTerminalOverlayHeightChange={setOptionOverlayHeight}
        />
      </ContentContainer>
      {source === "notifications" && (
        <NextNotification paneId={autoYesPaneId} jobName={slug} onSelect={handleSelectNotification} />
      )}
      {(keyboardVisible || terminalMenuOpen) && isRunningWithPty ? (
        <TerminalKeyboardToolbar
          bottom={keyboardVisible ? keyboardHeight : insets.bottom}
          onDismiss={dismissTerminalKeyboard}
          onEscape={() => sendTerminalText("\x1b")}
          onArrowUp={() => sendTerminalText("\x1b[A")}
          onArrowDown={() => sendTerminalText("\x1b[B")}
          onArrowLeft={() => sendTerminalText("\x1b[D")}
          onArrowRight={() => sendTerminalText("\x1b[C")}
          onCtrlC={() => sendTerminalText("\x03")}
          onPaste={sendTerminalText}
          onWrite={() => { setTerminalMenuOpen(false); setWriteOpen(true); }}
          menuOpen={terminalMenuOpen}
          onMenuOpenChange={handleTerminalMenuOpenChange}
        />
      ) : null}
      <TerminalWriteDialog
        visible={writeOpen}
        draft={writeDraft}
        onDraftChange={setWriteDraft}
        onClose={() => setWriteOpen(false)}
        onDone={() => {
          const text = writeDraft.replace(/\r\n|\n/g, "\r");
          sendTerminalText(text.endsWith("\r") ? text : text + "\r");
          setWriteOpen(false);
        }}
      />
      <TerminalCopySheet text={copyText} onClose={() => setCopyText(null)} />
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
  onPaste,
  onWrite,
  menuOpen,
  onMenuOpenChange,
}: {
  bottom: number;
  onDismiss: () => void;
  onEscape: () => void;
  onArrowUp: () => void;
  onArrowDown: () => void;
  onArrowLeft: () => void;
  onArrowRight: () => void;
  onCtrlC: () => void;
  onPaste: (text: string) => void;
  onWrite: () => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}) {
  let handlePasteDone = useCallback(() => onMenuOpenChange(false), [onMenuOpenChange]);

  return (
    <View style={[styles.keyboardToolbar, { bottom }]}>
      <TouchableOpacity style={styles.keyboardToolBtn} onPress={onDismiss} activeOpacity={0.7}>
        <Ionicons name="chevron-down" size={20} color={colors.text} />
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
      <View style={styles.keyboardToolSpacer} />
      <View style={styles.keyboardToolMenuWrap}>
        <TouchableOpacity style={styles.keyboardToolBtn} onPress={() => onMenuOpenChange(!menuOpen)} activeOpacity={0.7}>
          <Ionicons name="ellipsis-horizontal" size={20} color={colors.text} />
        </TouchableOpacity>
        {menuOpen ? (
          <View style={styles.keyboardPastePopover}>
            <TerminalPasteButton onPaste={onPaste} onDone={handlePasteDone} />
            <TouchableOpacity style={styles.keyboardWriteButton} onPress={onWrite} activeOpacity={0.7}>
              <Text style={styles.keyboardPasteTitle}>Write</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
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
  headerActions: { flexDirection: "row", alignItems: "center" },
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
  terminalSurface: {
    flex: 1,
    minHeight: 0,
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
  keyboardToolMenuWrap: {
    position: "relative",
    alignSelf: "center",
    zIndex: 220,
    elevation: 220,
  },
  keyboardPastePopover: {
    position: "absolute",
    right: 0,
    bottom: 42,
    width: 164,
    padding: 12,
    alignItems: "center",
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    zIndex: 240,
    elevation: 240,
  },
  keyboardPasteItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  keyboardPasteTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  keyboardWriteButton: {
    width: 120,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
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
