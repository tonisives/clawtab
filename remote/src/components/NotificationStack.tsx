import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";

import { useNotificationStore } from "../store/notifications";
import { useJobsStore } from "../store/jobs";
import { getWsSend, nextId } from "../hooks/useWebSocket";
import { NotificationCard } from "@clawtab/shared";
import { colors } from "@clawtab/shared";
import { spacing } from "@clawtab/shared";
import type { ClaudeProcess, ClaudeQuestion } from "@clawtab/shared";


function PaginationDots({
  count,
  activeIndex,
  onDotPress,
}: {
  count: number;
  activeIndex: number;
  onDotPress: (index: number) => void;
}) {
  if (count <= 1) return null;
  return (
    <View style={styles.dots}>
      {Array.from({ length: count }, (_, i) => (
        <TouchableOpacity
          key={i}
          onPress={() => onDotPress(i)}
          hitSlop={8}
          activeOpacity={0.6}
        >
          <View
            style={[styles.dot, i === activeIndex && styles.dotActive]}
          />
        </TouchableOpacity>
      ))}
    </View>
  );
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

  const scrollRef = useRef<ScrollView>(null);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const [activeIndex, setActiveIndex] = useState(0);
  const [cardWidth, setCardWidth] = useState(
    Dimensions.get("window").width - spacing.lg * 2,
  );

  const statuses = useJobsStore((s) => s.statuses);
  const jobs = useJobsStore((s) => s.jobs);

  const processMap = new Map<string, ClaudeProcess>();
  for (const proc of detectedProcesses) {
    processMap.set(proc.pane_id, proc);
  }

  const runningJobs = new Set<string>();
  for (const [name, status] of Object.entries(statuses)) {
    if (status.state === "running") runningJobs.add(name);
  }

  // Resolve the job name for a question: use matched_job, or fall back to
  // matching the question's cwd against running jobs' work_dir/group.
  const resolveJob = useCallback(
    (q: ClaudeQuestion): string | null => {
      if (q.matched_job && runningJobs.has(q.matched_job)) return q.matched_job;
      // Match by cwd
      for (const job of jobs) {
        if (!runningJobs.has(job.name)) continue;
        const dir = job.work_dir || job.path;
        if (!dir) continue;
        if (q.cwd === dir || q.cwd.startsWith(dir + "/")) return job.name;
      }
      // Match by group name
      if (q.matched_group) {
        for (const job of jobs) {
          if (!runningJobs.has(job.name)) continue;
          if (job.group === q.matched_group) return job.name;
        }
      }
      return null;
    },
    [jobs, runningJobs],
  );

  const activeQuestions = questions.filter(
    (q) => processMap.has(q.pane_id) || resolveJob(q) != null,
  );

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = e.nativeEvent.contentOffset.x;
      const idx = Math.round(offset / cardWidth);
      setActiveIndex(idx);
    },
    [cardWidth],
  );

  const handleLayout = useCallback(
    (e: { nativeEvent: { layout: { width: number } } }) => {
      setCardWidth(e.nativeEvent.layout.width);
    },
    [],
  );

  const scrollToIndex = useCallback(
    (idx: number) => {
      scrollRef.current?.scrollTo({ x: idx * cardWidth, animated: true });
      setActiveIndex(idx);
    },
    [cardWidth],
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

  const handleSendOption = useCallback(
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

  // Handle deep link
  useEffect(() => {
    if (!deepLinkQuestionId) return;
    const idx = activeQuestions.findIndex(
      (q) => q.question_id === deepLinkQuestionId,
    );
    if (idx >= 0) {
      if (scrollRef.current) {
        setTimeout(() => scrollToIndex(idx), 100);
      }
      navigateToQuestion(activeQuestions[idx], resolveJob(activeQuestions[idx]));
    }
    setDeepLinkQuestionId(null);
  }, [
    deepLinkQuestionId,
    activeQuestions,
    setDeepLinkQuestionId,
    scrollToIndex,
    navigateToQuestion,
  ]);

  // Clamp activeIndex
  useEffect(() => {
    if (activeIndex >= activeQuestions.length && activeQuestions.length > 0) {
      setActiveIndex(activeQuestions.length - 1);
    }
  }, [activeQuestions.length, activeIndex]);

  if (activeQuestions.length === 0) return null;

  if (activeQuestions.length === 1) {
    return (
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <NotificationCard
          question={activeQuestions[0]}
          resolvedJob={resolveJob(activeQuestions[0])}
          onNavigate={navigateToQuestion}
          onSendOption={handleSendOption}
        />
      </Animated.View>
    );
  }

  return (
    <Animated.View
      style={[styles.container, { opacity: fadeAnim }]}
      onLayout={handleLayout}
    >
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
      >
        {activeQuestions.map((q) => (
          <View
            key={q.question_id}
            style={{ width: cardWidth }}
          >
            <NotificationCard
              question={q}
              resolvedJob={resolveJob(q)}
              onNavigate={navigateToQuestion}
              onSendOption={handleSendOption}
            />
          </View>
        ))}
      </ScrollView>
      <PaginationDots
        count={activeQuestions.length}
        activeIndex={activeIndex}
        onDotPress={scrollToIndex}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    marginTop: spacing.sm,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.textMuted,
  },
  dotActive: {
    backgroundColor: colors.accent,
  },
});
