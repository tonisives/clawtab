import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";

import { useNotificationStore } from "../store/notifications";
import { useJobsStore } from "../store/jobs";
import { getWsSend, nextId } from "../hooks/useWebSocket";
import { NotificationSection } from "@clawtab/shared";
import { colors } from "@clawtab/shared";
import { spacing } from "@clawtab/shared";
import type { ClaudeProcess, ClaudeQuestion } from "@clawtab/shared";


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

  const statuses = useJobsStore((s) => s.statuses);

  const processMap = new Map<string, ClaudeProcess>();
  for (const proc of detectedProcesses) {
    processMap.set(proc.pane_id, proc);
  }

  const runningJobs = new Set<string>();
  for (const [name, status] of Object.entries(statuses)) {
    if (status.state === "running") runningJobs.add(name);
  }

  // Resolve the job name for a question.
  // Only trust matched_job from the backend (it checks actual pane ownership).
  // cwd-based matching is too aggressive since multiple Claude instances can
  // run in the same directory (e.g. a self-launched Claude inside a job folder).
  const resolveJob = useCallback(
    (q: ClaudeQuestion): string | null => {
      if (q.matched_job && runningJobs.has(q.matched_job)) return q.matched_job;
      return null;
    },
    [runningJobs],
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

  const handleSendOption = useCallback(
    (q: ClaudeQuestion, resolvedJob: string | null, optionNumber: string) => {
      const send = getWsSend();
      if (!send) return;
      // Optimistically remove the question so the card hides immediately
      answerQuestion(q.question_id);
      if (resolvedJob) {
        send({ type: "send_input", id: nextId(), name: resolvedJob, text: optionNumber });
      } else {
        const proc = processMap.get(q.pane_id);
        if (proc) {
          send({ type: "send_detected_process_input", id: nextId(), pane_id: proc.pane_id, text: optionNumber });
        }
      }
    },
    [processMap, answerQuestion],
  );

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

  // Keep rendering briefly after questions drop to 0 so departure animations play
  const [visible, setVisible] = useState(activeQuestions.length > 0);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (activeQuestions.length > 0) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setVisible(true);
    } else {
      // Wait for departure animation (300ms) + buffer
      hideTimer.current = setTimeout(() => setVisible(false), 500);
    }
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [activeQuestions.length]);

  if (!visible) return null;

  return (
    <View style={styles.container}>
      <NotificationSection
        questions={activeQuestions}
        resolveJob={resolveJob}
        onNavigate={navigateToQuestion}
        onSendOption={handleSendOption}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
      />
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
