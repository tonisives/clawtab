import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform, ActivityIndicator } from "react-native";
import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { useJobsStore } from "../../src/store/jobs";
import { useNotificationStore } from "../../src/store/notifications";
import { LogViewer, MessageInput, findYesOption, isFreetextOption, colors, radius, spacing } from "@clawtab/shared";
import { ContentContainer } from "../../src/components/ContentContainer";
import { useResponsive } from "../../src/hooks/useResponsive";
import { useWsStore } from "../../src/store/ws";
import { getWsSend, nextId } from "../../src/hooks/useWebSocket";
import { registerRequest } from "../../src/lib/useRequestMap";
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
  const { isWide } = useResponsive();
  const [logs, setLogs] = useState(process?.log_lines ?? "");
  const [logsLoaded, setLogsLoaded] = useState(!!process?.log_lines);
  const [stopping, setStopping] = useState(false);

  // Derive tmux info from process or question (for panes not in detectedProcesses)
  const paneQuestion = questions.find((q) => q.pane_id === pane_id);
  const tmuxSession = (process ?? lastProcess)?.tmux_session ?? paneQuestion?.tmux_session;

  const displayName = (process ?? lastProcess)
    ? (process ?? lastProcess)!.cwd.replace(/^\/Users\/[^/]+/, "~")
    : paneQuestion?.cwd.replace(/^\/Users\/[^/]+/, "~") ?? pane_id;

  // Poll logs - use lastProcess as fallback, then question for tmux_session
  const activeProcess = process ?? lastProcess;
  useEffect(() => {
    if (!tmuxSession) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const send = getWsSend();
        if (!send) return;
        const id = nextId();
        send({
          type: "get_detected_process_logs",
          id,
          tmux_session: tmuxSession,
          pane_id: pane_id,
        });
        const timeout = new Promise<{ logs?: string }>((resolve) =>
          setTimeout(() => resolve({}), 5000),
        );
        const resp = await Promise.race([registerRequest<{ logs?: string }>(id), timeout]);
        if (active && resp.logs != null) {
          setLogs(resp.logs.trimEnd());
          setLogsLoaded(true);
        }
      } finally {
        polling = false;
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [pane_id, tmuxSession]);

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

  const isAlive = !!process || !!paneQuestion;
  const isWeb = Platform.OS === "web";
  const outerScrollRef = useRef<ScrollView>(null);
  const outerWebRef = useRef<HTMLElement | null>(null);
  const prevLogsLenRef = useRef(0);

  const outerWebRefCb = useCallback((node: HTMLElement | null) => {
    outerWebRef.current = node;
  }, []);

  // Scroll to bottom when logs grow
  useEffect(() => {
    if (logs.length <= prevLogsLenRef.current) {
      prevLogsLenRef.current = logs.length;
      return;
    }
    prevLogsLenRef.current = logs.length;

    if (isWeb) {
      const el = outerWebRef.current;
      if (!el) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      });
    } else {
      outerScrollRef.current?.scrollToEnd({ animated: true });
    }
  }, [logs, isWeb]);

  const pageContent = (
    <ContentContainer wide>
      <View style={[styles.content, isWide && styles.contentWide]}>
        {isAlive && (
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.stopBtn, stopping && { opacity: 0.5 }]}
              onPress={handleStop}
              disabled={stopping}
              activeOpacity={0.7}
            >
              <Text style={styles.stopBtnText}>{stopping ? "Stopping..." : "Stop"}</Text>
            </TouchableOpacity>
          </View>
        )}

        {(process ?? lastProcess)?.first_query && (
          <View style={styles.queryRow}>
            <Text style={styles.queryLabel}>Query</Text>
            <Text style={styles.queryText} numberOfLines={3}>
              {(process ?? lastProcess)!.first_query}
            </Text>
          </View>
        )}

        <View style={styles.logsContainer}>
          {!logsLoaded && !tmuxSession ? (
            <View style={styles.loadingContainer}>
              <Text style={styles.loadingText}>Process not in detected list</Text>
            </View>
          ) : !logsLoaded ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.loadingText}>Loading logs...</Text>
            </View>
          ) : (
            <LogViewer content={logs} />
          )}
        </View>
      </View>
    </ContentContainer>
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

      {isWeb ? (
        <div
          ref={outerWebRefCb as any}
          style={{
            flex: 1,
            overflowY: "auto" as any,
            minHeight: 0,
          }}
        >
          {pageContent}
        </div>
      ) : (
        <ScrollView ref={outerScrollRef} style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {pageContent}
        </ScrollView>
      )}

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
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  content: { padding: spacing.lg, gap: spacing.lg, flex: 1 },
  contentWide: { paddingTop: 32, paddingHorizontal: spacing.xl },
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
  actions: { flexDirection: "row", gap: spacing.sm },
  stopBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.dangerBg,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  stopBtnText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
  queryRow: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  queryLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "600", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  queryText: { color: colors.text, fontSize: 13, fontFamily: "monospace" },
  logsContainer: { flex: 1, minHeight: 300 },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.md,
  },
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
