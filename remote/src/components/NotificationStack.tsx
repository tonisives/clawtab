import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";

import { useNotificationStore } from "../store/notifications";
import { useJobsStore } from "../store/jobs";
import { getWsSend, nextId } from "../hooks/useWebSocket";
import { ProcessCard } from "./ProcessCard";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";
import type { ClaudeProcess } from "../types/job";

const screenH = Dimensions.get("window").height;
const CARD_HEIGHT = Math.round(screenH / 3);

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
  const questions = useNotificationStore((s) => s.questions);
  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
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

  // Build a map from pane_id to detected process for quick lookup
  const processMap = new Map<string, ClaudeProcess>();
  for (const proc of detectedProcesses) {
    processMap.set(proc.pane_id, proc);
  }

  // Only show questions whose process still exists
  const activeQuestions = questions.filter((q) => processMap.has(q.pane_id));

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

  const handleAnswer = useCallback(
    (questionId: string, answer: string) => {
      const send = getWsSend();
      const question = questions.find((q) => q.question_id === questionId);
      if (send && question) {
        send({
          type: "answer_question",
          id: nextId(),
          question_id: questionId,
          pane_id: question.pane_id,
          answer,
        });
      }

      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start(() => {
        answerQuestion(questionId);
        fadeAnim.setValue(1);
        setActiveIndex((prev) =>
          prev >= activeQuestions.length - 1 ? Math.max(0, prev - 1) : prev,
        );
      });
    },
    [questions, activeQuestions.length, answerQuestion, fadeAnim],
  );

  // Handle deep link scroll
  useEffect(() => {
    if (!deepLinkQuestionId) return;
    const idx = activeQuestions.findIndex(
      (q) => q.question_id === deepLinkQuestionId,
    );
    if (idx >= 0 && scrollRef.current) {
      setTimeout(() => scrollToIndex(idx), 100);
    }
    setDeepLinkQuestionId(null);
  }, [
    deepLinkQuestionId,
    activeQuestions,
    setDeepLinkQuestionId,
    scrollToIndex,
  ]);

  // Clamp activeIndex when questions change
  useEffect(() => {
    if (activeIndex >= activeQuestions.length && activeQuestions.length > 0) {
      setActiveIndex(activeQuestions.length - 1);
    }
  }, [activeQuestions.length, activeIndex]);

  if (activeQuestions.length === 0) return null;

  // Single question - no gallery needed
  if (activeQuestions.length === 1) {
    const q = activeQuestions[0];
    const proc = processMap.get(q.pane_id)!;
    return (
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <ProcessCard process={proc} forceExpanded fixedHeight={CARD_HEIGHT} />
      </Animated.View>
    );
  }

  // Multiple questions - horizontal paging gallery
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
        {activeQuestions.map((q) => {
          const proc = processMap.get(q.pane_id)!;
          return (
            <View
              key={q.question_id}
              style={{ width: cardWidth }}
            >
              <ProcessCard
                process={proc}
                forceExpanded
                fixedHeight={CARD_HEIGHT}
              />
            </View>
          );
        })}
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
    marginBottom: spacing.sm,
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
