import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";

import { useNotificationStore } from "../store/notifications";
import { useJobsStore } from "../store/jobs";
import { getWsSend, nextId } from "../hooks/useWebSocket";
import { NotificationSection, AutoYesBanner, findYesOption } from "@clawtab/shared";
import { colors } from "@clawtab/shared";
import { spacing } from "@clawtab/shared";
import type { AutoYesEntry, ClaudeProcess, ClaudeQuestion } from "@clawtab/shared";

function syncAutoYesToRelay(paneIds: Set<string>) {
  const send = getWsSend();
  if (!send) return;
  send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...paneIds] });
}

export function NotificationStack() {
  const router = useRouter();
  const questions = useNotificationStore((s) => s.questions);
  const detectedProcesses = useJobsStore((s) => s.detectedProcesses);
  const deepLinkQuestionId = useNotificationStore(
    (s) => s.deepLinkQuestionId,
  );
  const setDeepLinkQuestionId = useNotificationStore(
    (s) => s.setDeepLinkQuestionId,
  );

  const [collapsed, setCollapsed] = useState(false);

  const processMap = new Map<string, ClaudeProcess>();
  for (const proc of detectedProcesses) {
    processMap.set(proc.pane_id, proc);
  }

  // Resolve the job name for a question.
  // After Phase 1, matched_job is only set for pane-id-authoritative matches,
  // so we can trust it directly.
  const resolveJob = useCallback(
    (q: ClaudeQuestion): string | null => q.matched_job ?? null,
    [],
  );

  const activeQuestions = questions.filter(
    (q) => processMap.has(q.pane_id) || resolveJob(q) != null,
  );

  const navigateToQuestion = useCallback(
    (_q: ClaudeQuestion, jobName: string | null) => {
      if (jobName) {
        router.push(`/job/${jobName}`);
      } else {
        router.push(`/process/${_q.pane_id.replace(/%/g, "_pct_")}`);
      }
    },
    [router],
  );

  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const enableAutoYes = useNotificationStore((s) => s.enableAutoYes);
  const disableAutoYes = useNotificationStore((s) => s.disableAutoYes);

  // Track which question IDs were auto-answered (for brief "Auto-accepted" display)
  const [autoAnsweredIds, setAutoAnsweredIds] = useState<Set<string>>(new Set());
  const autoAnsweredRef = useRef<Set<string>>(new Set());

  const sendAnswer = useCallback(
    (q: ClaudeQuestion, resolvedJob: string | null, optionNumber: string) => {
      const send = getWsSend();
      if (!send) return;
      if (resolvedJob) {
        send({ type: "send_input", id: nextId(), name: resolvedJob, text: optionNumber });
      } else {
        const proc = processMap.get(q.pane_id);
        if (proc) {
          send({ type: "send_detected_process_input", id: nextId(), pane_id: proc.pane_id, text: optionNumber });
        }
      }
    },
    [processMap],
  );

  const handleSendOption = useCallback(
    (q: ClaudeQuestion, resolvedJob: string | null, optionNumber: string) => {
      answerQuestion(q.question_id);
      sendAnswer(q, resolvedJob, optionNumber);
    },
    [answerQuestion, sendAnswer],
  );

  const handleToggleAutoYes = useCallback(
    (q: ClaudeQuestion) => {
      if (autoYesPaneIds.has(q.pane_id)) {
        disableAutoYes(q.pane_id);
        const next = new Set(autoYesPaneIds);
        next.delete(q.pane_id);
        syncAutoYesToRelay(next);
        return;
      }

      const title = q.matched_job ?? q.cwd.replace(/^\/Users\/[^/]+/, "~");
      Alert.alert(
        "Enable auto-yes?",
        `All future questions for "${title}" will be automatically accepted with "Yes". This stays active until you disable it.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Enable",
            style: "destructive",
            onPress: () => {
              enableAutoYes(q.pane_id);
              const next = new Set(autoYesPaneIds);
              next.add(q.pane_id);
              syncAutoYesToRelay(next);
              // Auto-answer the current question
              const yesOpt = findYesOption(q);
              if (yesOpt) {
                autoAnsweredRef.current.add(q.question_id);
                setAutoAnsweredIds(new Set(autoAnsweredRef.current));
                sendAnswer(q, resolveJob(q), yesOpt);
                // Dismiss after a brief flash
                setTimeout(() => {
                  answerQuestion(q.question_id);
                }, 1500);
              }
            },
          },
        ],
      );
    },
    [autoYesPaneIds, enableAutoYes, disableAutoYes, sendAnswer, resolveJob, answerQuestion],
  );

  // Auto-answering is handled by the desktop Rust backend.
  // Mobile only displays auto-yes state.

  // Handle deep link
  useEffect(() => {
    if (!deepLinkQuestionId) return;
    const idx = activeQuestions.findIndex(
      (q) => q.question_id === deepLinkQuestionId,
    );
    if (idx >= 0) {
      navigateToQuestion(activeQuestions[idx], resolveJob(activeQuestions[idx]));
    }
    setDeepLinkQuestionId(null);
  }, [
    deepLinkQuestionId,
    activeQuestions,
    setDeepLinkQuestionId,
    navigateToQuestion,
  ]);

  // Build auto-yes entries for the banner (panes with auto-yes, even without active questions)
  const autoYesEntries: AutoYesEntry[] = useMemo(() => {
    const entries: AutoYesEntry[] = [];
    for (const paneId of autoYesPaneIds) {
      // Try to find a label from active questions first
      const q = questions.find((q) => q.pane_id === paneId);
      if (q) {
        const label = q.matched_job ?? q.cwd.replace(/^\/Users\/[^/]+/, "~");
        entries.push({ paneId, label });
        continue;
      }
      // Try detected processes
      const proc = processMap.get(paneId);
      if (proc) {
        const label = proc.matched_job ?? proc.cwd.replace(/^\/Users\/[^/]+/, "~");
        entries.push({ paneId, label });
        continue;
      }
      entries.push({ paneId, label: paneId });
    }
    return entries;
  }, [autoYesPaneIds, questions, processMap]);

  const handleDisableAutoYes = useCallback(
    (paneId: string) => {
      disableAutoYes(paneId);
      const next = new Set(autoYesPaneIds);
      next.delete(paneId);
      syncAutoYesToRelay(next);
    },
    [autoYesPaneIds, disableAutoYes],
  );

  // Keep rendering briefly after questions drop to 0 so departure animations play
  const hasContent = activeQuestions.length > 0 || autoYesEntries.length > 0;
  const [visible, setVisible] = useState(hasContent);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (hasContent) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setVisible(true);
    } else {
      // Wait for departure animation (300ms) + buffer
      hideTimer.current = setTimeout(() => setVisible(false), 500);
    }
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [hasContent]);

  if (!visible) return null;

  return (
    <View style={styles.container}>
      <AutoYesBanner entries={autoYesEntries} onDisable={handleDisableAutoYes} />
      {activeQuestions.length > 0 && (
        <NotificationSection
          questions={activeQuestions}
          resolveJob={resolveJob}
          onNavigate={navigateToQuestion}
          onSendOption={handleSendOption}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          autoYesPaneIds={autoYesPaneIds}
          onToggleAutoYes={handleToggleAutoYes}
          autoAnsweredIds={autoAnsweredIds}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
});
