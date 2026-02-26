import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { Ionicons } from "@expo/vector-icons";

import { useNotificationStore } from "../store/notifications";
import { useJobsStore } from "../store/jobs";
import { getWsSend, nextId } from "../hooks/useWebSocket";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import type { ClaudeProcess, ClaudeQuestion } from "../types/job";


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

function NotificationCard({
  question,
  processMap,
  resolvedJob,
  onNavigate,
}: {
  question: ClaudeQuestion;
  processMap: Map<string, ClaudeProcess>;
  resolvedJob: string | null;
  onNavigate: (q: ClaudeQuestion, jobName: string | null) => void;
}) {
  const [answered, setAnswered] = useState(false);
  const prevQuestionId = useRef(question.question_id);

  // If the question_id changes (new question detected), reset answered state
  useEffect(() => {
    if (question.question_id !== prevQuestionId.current) {
      prevQuestionId.current = question.question_id;
      setAnswered(false);
    }
  }, [question.question_id]);

  // Auto-reset after 10s so buttons re-appear if question persists
  useEffect(() => {
    if (!answered) return;
    const timer = setTimeout(() => setAnswered(false), 10000);
    return () => clearTimeout(timer);
  }, [answered]);

  const handleOptionPress = (optionNumber: string) => {
    const send = getWsSend();
    if (!send) return;
    if (resolvedJob) {
      send({ type: "send_input", id: nextId(), name: resolvedJob, text: optionNumber });
    } else {
      const proc = processMap.get(question.pane_id);
      if (proc) {
        send({ type: "send_detected_process_input", id: nextId(), pane_id: proc.pane_id, text: optionNumber });
      }
    }
    setAnswered(true);
  };

  const proc = processMap.get(question.pane_id);
  const title = resolvedJob
    ? resolvedJob
    : proc
      ? proc.cwd.replace(/^\/Users\/[^/]+/, "~")
      : question.cwd.replace(/^\/Users\/[^/]+/, "~");

  const lines = question.context_lines
    .trim()
    .split("\n")
    .filter((l) => !/^[\s\-_=~]{10,}$/.test(l)); // drop decorative separator lines
  const preview = lines.join("\n").trim();

  return (
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.cardBody}
        onPress={() => onNavigate(question, resolvedJob)}
        activeOpacity={0.7}
      >
        <View style={styles.cardHeader}>
          <View style={styles.questionBadge}>
            <Ionicons name="alert-circle" size={14} color={colors.warning} />
            <Text style={styles.questionLabel}>Waiting for input</Text>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.openText}>Open</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
          </View>
        </View>
        <Text style={styles.cardTitle} numberOfLines={1}>{title}</Text>

        {preview ? (
          <View style={styles.logPreview}>
            <Text style={styles.logText}>{preview}</Text>
          </View>
        ) : null}
      </TouchableOpacity>

      {question.options.length > 0 && (
        answered ? (
          <View style={styles.sentRow}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.sentText}>Sent</Text>
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.optionRow}
            contentContainerStyle={styles.optionRowContent}
          >
            {question.options.map((opt) => (
              <TouchableOpacity
                key={opt.number}
                style={styles.optionBtn}
                onPress={() => handleOptionPress(opt.number)}
                activeOpacity={0.6}
              >
                <Text style={styles.optionBtnText} numberOfLines={1}>
                  {opt.number}. {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )
      )}
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
      return q.matched_job || null;
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
    (q: ClaudeQuestion, jobName: string | null) => {
      if (jobName) {
        router.push(`/job/${jobName}`);
      } else {
        router.push(`/process/${q.pane_id.replace(/%/g, "_pct_")}`);
      }
    },
    [router],
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
          processMap={processMap}
          resolvedJob={resolveJob(activeQuestions[0])}
          onNavigate={navigateToQuestion}
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
              processMap={processMap}
              resolvedJob={resolveJob(q)}
              onNavigate={navigateToQuestion}
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
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    minHeight: 120,
    overflow: "hidden",
  },
  cardBody: {
    flex: 1,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  questionBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  questionLabel: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: "600",
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  openText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "500",
  },
  logPreview: {
    flex: 1,
    backgroundColor: "#000",
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: 2,
  },
  logText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: "monospace",
    lineHeight: 16,
  },
  optionRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    maxHeight: 44,
  },
  optionRowContent: {
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
  optionBtnText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "500",
  },
  sentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 8,
  },
  sentText: {
    color: colors.textMuted,
    fontSize: 12,
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
