import { useCallback, useEffect, useRef } from "react";
import {
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { useNotificationStore } from "../store/notifications";
import { getWsSend, nextId } from "../hooks/useWebSocket";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import type { ClaudeQuestion } from "../types/job";

function QuestionCard({
  question,
  onAnswer,
}: {
  question: ClaudeQuestion;
  onAnswer: (questionId: string, answer: string) => void;
}) {
  const project = question.cwd.replace(/^\/Users\/[^/]+/, "~");
  const shortProject = project.split("/").slice(-2).join("/");

  return (
    <View style={styles.card}>
      <Text style={styles.cardProject} numberOfLines={1}>
        {shortProject}
      </Text>
      {question.context_lines ? (
        <Text style={styles.cardContext} numberOfLines={2}>
          {question.context_lines}
        </Text>
      ) : null}
      <View style={styles.cardOptions}>
        {question.options.map((opt) => (
          <TouchableOpacity
            key={opt.number}
            style={styles.optionBtn}
            onPress={() => onAnswer(question.question_id, opt.number)}
            activeOpacity={0.6}
          >
            <Text style={styles.optionBtnText} numberOfLines={1}>
              {opt.number}. {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export function NotificationStack() {
  const questions = useNotificationStore((s) => s.questions);
  const expanded = useNotificationStore((s) => s.expanded);
  const deepLinkQuestionId = useNotificationStore((s) => s.deepLinkQuestionId);
  const setExpanded = useNotificationStore((s) => s.setExpanded);
  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const setDeepLinkQuestionId = useNotificationStore(
    (s) => s.setDeepLinkQuestionId,
  );
  const scrollRef = useRef<ScrollView>(null);
  const fadeAnim = useRef(new Animated.Value(1)).current;

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

      // Animate out
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start(() => {
        answerQuestion(questionId);
        fadeAnim.setValue(1);
      });
    },
    [questions, answerQuestion, fadeAnim],
  );

  // Handle deep link scroll
  useEffect(() => {
    if (!deepLinkQuestionId || !expanded) return;
    const idx = questions.findIndex(
      (q) => q.question_id === deepLinkQuestionId,
    );
    if (idx >= 0 && scrollRef.current) {
      setTimeout(() => {
        scrollRef.current?.scrollTo({ x: idx * 280, animated: true });
      }, 100);
    }
    setDeepLinkQuestionId(null);
  }, [deepLinkQuestionId, expanded, questions, setDeepLinkQuestionId]);

  if (questions.length === 0) return null;

  if (!expanded) {
    // Collapsed: show top card + badge
    const topQuestion = questions[0];
    return (
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        <QuestionCard question={topQuestion} onAnswer={handleAnswer} />
        {questions.length > 1 && (
          <TouchableOpacity
            style={styles.badge}
            onPress={() => setExpanded(true)}
            activeOpacity={0.6}
          >
            <Text style={styles.badgeText}>
              {questions.length} questions waiting
            </Text>
          </TouchableOpacity>
        )}
      </Animated.View>
    );
  }

  // Expanded: horizontal paging gallery
  return (
    <View style={styles.container}>
      <View style={styles.expandedHeader}>
        <Text style={styles.expandedTitle}>
          {questions.length} question{questions.length !== 1 ? "s" : ""}
        </Text>
        <TouchableOpacity
          onPress={() => setExpanded(false)}
          activeOpacity={0.6}
        >
          <Text style={styles.collapseBtn}>Collapse</Text>
        </TouchableOpacity>
      </View>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled={false}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.galleryContent}
        decelerationRate="fast"
        snapToInterval={288}
      >
        {questions.map((q) => (
          <View key={q.question_id} style={styles.galleryCard}>
            <QuestionCard question={q} onAnswer={handleAnswer} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.accent,
    borderLeftWidth: 3,
    gap: spacing.sm,
  },
  cardProject: {
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: "monospace",
  },
  cardContext: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 18,
  },
  cardOptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  optionBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accent,
    flexShrink: 1,
  },
  optionBtnText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "500",
  },
  badge: {
    alignSelf: "center",
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 12,
    backgroundColor: colors.accentBg,
  },
  badgeText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "500",
  },
  expandedHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  expandedTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  collapseBtn: {
    color: colors.accent,
    fontSize: 12,
  },
  galleryContent: {
    gap: spacing.sm,
  },
  galleryCard: {
    width: 280,
  },
});
