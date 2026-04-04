import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator } from "react-native";
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { useJobsStore } from "../../src/store/jobs";
import { useNotificationStore } from "../../src/store/notifications";
import { XtermLog, MessageInput, findYesOption, isFreetextOption, colors, radius, spacing } from "@clawtab/shared";
import type { XtermLogHandle } from "@clawtab/shared";
import { useWsStore } from "../../src/store/ws";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { registerRequest } from "../../src/lib/useRequestMap";
import { usePty } from "../../src/hooks/usePty";
import { confirm } from "../../src/lib/platform";

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

  // "Type something" mode: when a freetext option is selected, the next
  // MessageInput submission sends keystroke + freetext instead of literal text.
  const [freetextOptionNumber, setFreetextOptionNumber] = useState<string | null>(null);

  // Reset freetext mode when the question changes
  useEffect(() => {
    setFreetextOptionNumber(null);
  }, [paneQuestion?.question_id]);

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

      if (freetextOptionNumber) {
        // In freetext mode: send keystroke for option number + typed text via answer_question
        send({
          type: "answer_question",
          id: nextId(),
          question_id: paneQuestion?.question_id ?? "",
          pane_id,
          answer: freetextOptionNumber,
          freetext: text.trim(),
        });
        setFreetextOptionNumber(null);
      } else {
        send({
          type: "send_detected_process_input",
          id: nextId(),
          pane_id,
          text: text.trim(),
        });
      }
      // Dismiss notification card if we just answered a question
      if (paneQuestion) {
        answerQuestion(paneQuestion.question_id);
      }
    },
    [pane_id, paneQuestion, answerQuestion, freetextOptionNumber],
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
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: displayName,
          headerRight: () => (
            <View style={isAlive ? styles.runningBadge : styles.endedBadge}>
              <Text style={isAlive ? styles.runningText : styles.endedText}>
                {isAlive ? "running" : "ended"}
              </Text>
            </View>
          ),
        }}
      />

      {(process ?? lastProcess) && (
        <View style={styles.pathRow}>
          <Text style={styles.pathText} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.versionText}>v{(process ?? lastProcess)!.version}</Text>
        </View>
      )}

      {activeProcess?.first_query && (
        <View style={styles.queryRow}>
          <Text style={styles.queryLabel}>Query</Text>
          <Text style={styles.queryText} numberOfLines={3}>
            {activeProcess.first_query}
          </Text>
        </View>
      )}
      {activeProcess?.last_query && activeProcess.last_query !== activeProcess.first_query && (
        <View style={styles.queryRow}>
          <Text style={styles.queryLabel}>Latest</Text>
          <Text style={[styles.queryText, { color: colors.textSecondary }]} numberOfLines={3}>
            {activeProcess.last_query}
          </Text>
        </View>
      )}

      <View style={styles.actions}>
        {isAlive ? (
          <TouchableOpacity
            style={[styles.stopBtn, stopping && { opacity: 0.5 }]}
            onPress={handleStop}
            disabled={stopping}
            activeOpacity={0.7}
          >
            <Text style={styles.stopBtnText}>{stopping ? "Stopping..." : "Stop"}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.startBtn, starting && { opacity: 0.5 }]}
            onPress={handleStart}
            disabled={starting}
            activeOpacity={0.7}
          >
            <Text style={styles.startBtnText}>{starting ? "Starting..." : "Start"}</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.terminalContainer}>
        {ptyConnecting && (
          <View style={styles.ptyConnecting}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.ptyConnectingText}>Connecting to terminal...</Text>
          </View>
        )}
        <XtermLog
          ref={termRef}
          onData={ptySendInput}
          onResize={sendResize}
          interactive
        />
      </View>

      {(isAlive || paneQuestion) && <OptionButtons options={options} onSend={handleSend} onFreetextOption={setFreetextOptionNumber} autoYesActive={autoYesActive} onToggleAutoYes={handleToggleAutoYes} />}
      {(isAlive || paneQuestion) && (
        <MessageInput
          onSend={handleSend}
          placeholder={freetextOptionNumber ? "Type your answer..." : "Send input..."}
        />
      )}
    </View>
  );
}

function OptionButtons({
  options,
  onSend,
  onFreetextOption,
  autoYesActive,
  onToggleAutoYes,
}: {
  options: { number: string; label: string }[];
  onSend: (text: string) => void;
  onFreetextOption?: (optionNumber: string) => void;
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
            if (isFreetextOption(opt.label) && onFreetextOption) {
              onFreetextOption(opt.number);
            } else {
              onSend(opt.number);
            }
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
  runningBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: colors.accentBg,
  },
  runningText: { fontSize: 11, fontWeight: "500", letterSpacing: 0.3, color: colors.accent },
  endedBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: "rgba(152, 152, 157, 0.12)",
  },
  endedText: { fontSize: 11, fontWeight: "500", letterSpacing: 0.3, color: colors.textMuted },
  pathRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 4,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pathText: { flex: 1, color: colors.textMuted, fontSize: 11, fontFamily: "monospace" },
  versionText: { color: colors.textSecondary, fontSize: 11 },
  actions: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  stopBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.dangerBg,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  stopBtnText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
  startBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accentBg,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  startBtnText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  queryRow: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  queryLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "600", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  queryText: { color: colors.text, fontSize: 13, fontFamily: "monospace" },
  terminalContainer: { flex: 1, minHeight: 0 },
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
