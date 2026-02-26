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

const SCREEN_HEIGHT = Dimensions.get("window").height;
const CARD_MIN_HEIGHT = Math.round(SCREEN_HEIGHT / 3);

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
  onNavigate,
}: {
  question: ClaudeQuestion;
  processMap: Map<string, ClaudeProcess>;
  onNavigate: (q: ClaudeQuestion) => void;
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

  const handleOptionPress = (optionNumber: string) => {
    const send = getWsSend();
    if (!send) return;
    if (question.matched_job) {
      send({ type: "send_input", id: nextId(), name: question.matched_job, text: optionNumber });
    } else {
      const proc = processMap.get(question.pane_id);
      if (proc) {
        send({ type: "send_detected_process_input", id: nextId(), pane_id: proc.pane_id, text: optionNumber });
      }
    }
    setAnswered(true);
  };

  const proc = processMap.get(question.pane_id);
  const title = question.matched_job
    ? question.matched_job
    : proc
      ? proc.cwd.replace(/^\/Users\/[^/]+/, "~")
      : question.cwd.replace(/^\/Users\/[^/]+/, "~");

  const lines = question.context_lines.trim().split("\n");
  const preview = lines.slice(-8).join("\n").trim();

  return (
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.cardBody}
        onPress={() => onNavigate(question)}
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
            <Text style={styles.logText} numberOfLines={8}>{preview}</Text>
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
                  {opt.number}. {opt.label.length > 30 ? opt.label.slice(0, 30) + "..." : opt.label}
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

  const processMap = new Map<string, ClaudeProcess>();
  for (const proc of detectedProcesses) {
    processMap.set(proc.pane_id, proc);
  }

  const runningJobs = new Set<string>();
  for (const [name, status] of Object.entries(statuses)) {
    if (status.state === "running") runningJobs.add(name);
  }

  const activeQuestions = questions.filter(
    (q) => processMap.has(q.pane_id) || (q.matched_job && runningJobs.has(q.matched_job)),
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
    (q: ClaudeQuestion) => {
      if (q.matched_job) {
        router.push(`/job/${q.matched_job}`);
      } else {
        router.push(`/process/${q.pane_id}`);
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
      navigateToQuestion(activeQuestions[idx]);
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
    minHeight: CARD_MIN_HEIGHT,
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
