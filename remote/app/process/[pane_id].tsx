import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Platform, KeyboardAvoidingView, Keyboard, Alert } from "react-native";
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useJobsStore } from "../../src/store/jobs";
import { useNotificationStore } from "../../src/store/notifications";
import { XtermLog, PopupMenu, findYesOption, colors, radius, spacing } from "@clawtab/shared";
import type { XtermLogHandle } from "@clawtab/shared";
import { useWsStore } from "../../src/store/ws";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { registerRequest } from "../../src/lib/useRequestMap";
import { usePty } from "../../src/hooks/usePty";
import { confirm } from "../../src/lib/platform";

const KEYBOARD_EXTRA_LIFT = 72;

export default function ProcessDetailScreen() {
  const { pane_id: rawPaneId } = useLocalSearchParams<{ pane_id: string }>();
  const router = useRouter();

  // Tmux pane_ids start with % (e.g. %714) which gets mangled by URL encoding.
  // We encode % as _pct_ in URLs and decode it back here.
  const pane_id = (rawPaneId ?? "").replace(/_pct_/g, "%");

  const process = useJobsStore((s) =>
    s.detectedProcesses.find((p) => p.pane_id === pane_id),
  );

  // If this pane belongs to a tracked job (not in detectedProcesses), redirect
  // to the job detail page instead.
  const jobs = useJobsStore((s) => s.jobs);
  const statuses = useJobsStore((s) => s.statuses);
  const questions = useNotificationStore((s) => s.questions);
  useEffect(() => {
    if (process) return; // found as detected process, no redirect needed
    const paneQuestions = questions.filter((q) => q.pane_id === pane_id);
    for (const q of paneQuestions) {
      if (q.matched_job) {
        router.replace(`/job/${q.matched_job}`);
        return;
      }
      for (const job of jobs) {
        if (statuses[job.name]?.state !== "running") continue;
        const dir = job.work_dir || job.path;
        if (dir && (q.cwd === dir || q.cwd.startsWith(dir + "/"))) {
          router.replace(`/job/${job.name}`);
          return;
        }
      }
      if (q.matched_group) {
        for (const job of jobs) {
          if (statuses[job.name]?.state !== "running") continue;
          if (job.group === q.matched_group) {
            router.replace(`/job/${job.name}`);
            return;
          }
        }
      }
    }
  }, [process, pane_id, questions, jobs, statuses, router]);

  const connected = useWsStore((s) => s.connected);
  const desktopOnline = useWsStore((s) => s.desktopOnline);
  const loaded = useJobsStore((s) => s.loaded);

  // Cold start from notification: waiting for relay data
  const waitingForData = !process && !questions.some((q) => q.pane_id === pane_id) && (!connected || !desktopOnline || !loaded);

  const lastProcessRef = useRef(process);
  if (process) lastProcessRef.current = process;
  const lastProcess = lastProcessRef.current;
  const [stopping, setStopping] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const contextMenuRef = useRef<View>(null);
  const contextDropdownRef = useRef<View>(null);
  const contextButtonRef = useRef<any>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
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

  // Derive tmux info from process or question (for panes not in detectedProcesses)
  const paneQuestion = questions.find((q) => q.pane_id === pane_id);
  const tmuxSession = (process ?? lastProcess)?.tmux_session ?? paneQuestion?.tmux_session ?? "";

  const displayName = (process ?? lastProcess)
    ? (process ?? lastProcess)!.cwd.replace(/^\/Users\/[^/]+/, "~")
    : paneQuestion?.cwd.replace(/^\/Users\/[^/]+/, "~") ?? pane_id;

  const activeProcess = process ?? lastProcess;

  // PTY streaming terminal
  const termRef = useRef<XtermLogHandle | null>(null);
  const { sendInput: ptySendInput, sendResize, connecting: ptyConnecting } = usePty(pane_id, tmuxSession, termRef);

  const options = paneQuestion?.options ?? [];

  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const enableAutoYes = useNotificationStore((s) => s.enableAutoYes);
  const disableAutoYes = useNotificationStore((s) => s.disableAutoYes);
  const autoYesActive = autoYesPaneIds.has(pane_id);

  const handleToggleAutoYes = useCallback(() => {
    if (autoYesPaneIds.has(pane_id)) {
      disableAutoYes(pane_id);
      const send = getWsSend();
      if (send) {
        const next = new Set(autoYesPaneIds);
        next.delete(pane_id);
        send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] });
      }
      return;
    }
    const title = displayName;
    confirm("Enable auto-yes?", `All future questions for "${title}" will be automatically accepted with "Yes". This stays active until you disable it.`, () => {
      enableAutoYes(pane_id);
      const send = getWsSend();
      if (send) {
        const next = new Set(autoYesPaneIds);
        next.add(pane_id);
        send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] });
      }
      if (paneQuestion) {
        const yesOpt = findYesOption(paneQuestion);
        if (yesOpt) {
          const s = getWsSend();
          if (s) {
            s({ type: "send_detected_process_input", id: nextId(), pane_id, text: yesOpt });
          }
          setTimeout(() => answerQuestion(paneQuestion.question_id), 1500);
        }
      }
    });
  }, [pane_id, autoYesPaneIds, enableAutoYes, disableAutoYes, displayName, paneQuestion, answerQuestion]);

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

  const sendTmuxPaneKey = useCallback(
    (key: string) => {
      const send = getWsSend();
      if (!send) return;
      send({ type: "tmux_pane_key", pane_id, key });
    },
    [pane_id],
  );

  const scrollTerminal = useCallback(
    (direction: "up" | "down") => {
      sendTmuxPaneKey("copy-mode");
      setTimeout(() => sendTmuxPaneKey(direction === "up" ? "C-u" : "C-d"), 30);
    },
    [sendTmuxPaneKey],
  );

  const doStop = async () => {
    const send = getWsSend();
    if (!send || stopping) return;
    setStopping(true);
    const id = nextId();
    send({ type: "stop_detected_process", id, pane_id });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([registerRequest(id), timeout]);
    setStopping(false);
  };

  const handleStop = () => {
    confirm("Stop process", `Kill the Claude process in ${displayName}?`, doStop);
  };

  const [starting, setStarting] = useState(false);
  const handleStart = async () => {
    const send = getWsSend();
    if (!send || starting) return;
    setStarting(true);
    const workDir = (process ?? lastProcess)?.cwd;
    const id = nextId();
    send({ type: "run_agent", id, prompt: "", work_dir: workDir });
    setTimeout(() => setStarting(false), 3000);
  };

  const isAlive = !!process || !!paneQuestion;
  const openContextMenu = useCallback(
    (e?: any) => {
      Keyboard.dismiss();

      if (Platform.OS !== "web") {
        Alert.alert(
          displayName,
          undefined,
          [
            { text: "Hide Keyboard", onPress: () => Keyboard.dismiss() },
            isAlive
              ? { text: stopping ? "Stopping..." : "Stop", onPress: handleStop, style: "destructive" }
              : { text: starting ? "Starting..." : "Start", onPress: handleStart },
            { text: "Cancel", style: "cancel" },
          ],
        );
        return;
      }

      const node = contextButtonRef.current?.getBoundingClientRect
        ? contextButtonRef.current
        : (e?.currentTarget ?? e?.target);
      if (node?.getBoundingClientRect) {
        const rect = node.getBoundingClientRect();
        setMenuPos({ top: rect.bottom + 4, left: rect.right });
      }
      setShowContextMenu((v) => !v);
    },
    [displayName, handleStart, handleStop, isAlive, starting, stopping],
  );

  if (waitingForData) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: pane_id }} />
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>
            {!connected ? "Connecting..." : "Loading..."}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={-KEYBOARD_EXTRA_LIFT}
    >
      <Stack.Screen
        options={{
          title: displayName,
          headerRight: () => (
            <View style={styles.headerActions}>
              <TouchableOpacity
                style={styles.stateDotHitbox}
                onPress={() => Keyboard.dismiss()}
                activeOpacity={0.6}
                hitSlop={8}
              >
                <View style={[styles.stateDot, isAlive ? styles.runningDot : styles.endedDot]} />
              </TouchableOpacity>
              <View ref={contextMenuRef} style={styles.contextWrap}>
                <TouchableOpacity
                  ref={contextButtonRef}
                  style={styles.contextBtn}
                  onPress={openContextMenu}
                  activeOpacity={0.6}
                  hitSlop={8}
                >
                  <Ionicons name="ellipsis-horizontal" size={20} color={colors.text} />
                </TouchableOpacity>
                {Platform.OS === "web" && showContextMenu && (
                  <PopupMenu
                    dropdownRef={contextDropdownRef}
                    triggerRef={contextButtonRef}
                    position={menuPos}
                    onClose={() => setShowContextMenu(false)}
                    items={isAlive ? [
                      { type: "item", label: "Hide Keyboard", onPress: () => Keyboard.dismiss() },
                      { type: "item", label: stopping ? "Stopping..." : "Stop", onPress: handleStop, color: colors.danger },
                    ] : [
                      { type: "item", label: "Hide Keyboard", onPress: () => Keyboard.dismiss() },
                      { type: "item", label: starting ? "Starting..." : "Start", onPress: handleStart, color: colors.accent },
                    ]}
                  />
                )}
              </View>
            </View>
          ),
        }}
      />

      {activeProcess?.first_query && (
        <View style={styles.queryRow}>
          <Text style={styles.queryLabel}>Query</Text>
          <Text style={styles.queryText} numberOfLines={1}>
            {activeProcess.first_query}
          </Text>
        </View>
      )}
      {activeProcess?.last_query && activeProcess.last_query !== activeProcess.first_query && (
        <View style={styles.queryRow}>
          <Text style={styles.queryLabel}>Latest</Text>
          <Text style={[styles.queryText, { color: colors.textSecondary }]} numberOfLines={1}>
            {activeProcess.last_query}
          </Text>
        </View>
      )}

      <View style={styles.terminalContainer}>
        {ptyConnecting && (
          <View style={styles.ptyConnecting}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.ptyConnectingText}>Connecting to terminal...</Text>
          </View>
        )}
        <TerminalScrollButtons
          onScrollUp={() => scrollTerminal("up")}
          onScrollDown={() => scrollTerminal("down")}
        />
        <XtermLog
          ref={termRef}
          onData={ptySendInput}
          onResize={sendResize}
          interactive
        />
      </View>

      {(isAlive || paneQuestion) && <OptionButtons options={options} onSend={handleSend} autoYesActive={autoYesActive} onToggleAutoYes={handleToggleAutoYes} />}
      {keyboardBuffer > 0 ? <View style={{ height: keyboardBuffer }} /> : null}
    </KeyboardAvoidingView>
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

function OptionButtons({
  options,
  onSend,
  autoYesActive,
  onToggleAutoYes,
}: {
  options: { number: string; label: string }[];
  onSend: (text: string) => void;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
}) {
  if (options.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.optionBar}
      contentContainerStyle={styles.optionBarContent}
    >
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.number}
          style={styles.optionBtn}
          onPress={() => {
            onSend(opt.number);
          }}
          activeOpacity={0.6}
        >
          <Text style={styles.optionBtnText}>
            {opt.number}. {opt.label.length > 25 ? opt.label.slice(0, 25) + "..." : opt.label}
          </Text>
        </TouchableOpacity>
      ))}
      {onToggleAutoYes && (
        <>
          <View style={styles.autoYesSeparator} />
          <TouchableOpacity
            style={[styles.autoYesBtn, autoYesActive && styles.autoYesBtnActive]}
            onPress={onToggleAutoYes}
            activeOpacity={0.6}
          >
            <Text style={styles.autoYesBtnText} numberOfLines={1}>
              {autoYesActive ? "! Auto ON" : "! Yes all"}
            </Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  notFound: { color: colors.textMuted, fontSize: 16 },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  stateDotHitbox: {
    width: 24,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  stateDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  runningDot: {
    backgroundColor: colors.accent,
  },
  endedDot: {
    backgroundColor: colors.textMuted,
  },
  contextWrap: {
    position: "relative",
    zIndex: 9999,
  },
  contextBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  queryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  queryLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "600", width: 42 },
  queryText: { flex: 1, minWidth: 0, color: colors.text, fontSize: 12, fontFamily: "monospace" },
  terminalContainer: { flex: 1, minHeight: 0, position: "relative" },
  scrollControls: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
    zIndex: 20,
    gap: 6,
  },
  scrollBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(28, 28, 30, 0.82)",
  },
  ptyConnecting: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 8,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ptyConnectingText: { color: colors.textMuted, fontSize: 12 },
  loadingText: { color: colors.textMuted, fontSize: 13 },
  optionBar: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
    maxHeight: 44,
  },
  optionBarContent: {
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    alignItems: "center",
  },
  optionBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  optionBtnText: { color: colors.accent, fontSize: 12, fontWeight: "500" },
  autoYesSeparator: { width: 1, height: 18, backgroundColor: colors.border },
  autoYesBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  autoYesBtnActive: { backgroundColor: colors.warningBg },
  autoYesBtnText: { color: colors.warning, fontSize: 12, fontWeight: "600" },
});
