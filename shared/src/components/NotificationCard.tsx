import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { ClaudeQuestion } from "../types/process";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export interface NotificationCardProps {
  question: ClaudeQuestion;
  resolvedJob: string | null;
  onNavigate: (question: ClaudeQuestion, resolvedJob: string | null) => void;
  onSendOption: (question: ClaudeQuestion, resolvedJob: string | null, optionNumber: string) => void;
}

export function NotificationCard({
  question,
  resolvedJob,
  onNavigate,
  onSendOption,
}: NotificationCardProps) {
  const [answered, setAnswered] = useState(false);
  const prevQuestionId = useRef(question.question_id);

  // Reset answered state when question changes
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
    onSendOption(question, resolvedJob, optionNumber);
    setAnswered(true);
  };

  const title = resolvedJob
    ? resolvedJob
    : question.cwd.replace(/^\/Users\/[^/]+/, "~");

  const lines = question.context_lines
    .trim()
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (!t) return true;
      return !/^[\s\-_=~\u2501\u2500\u2550\u254C\u254D\u2504\u2505\u2508\u2509\u2574\u2576\u2578\u257A\u2594\u2581|│┃┆┇┊┋╎╏]+$/.test(t);
    });
  const preview = lines.join("\n").trim();

  return (
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.cardBody}
        onPress={() => onNavigate(question, resolvedJob)}
        activeOpacity={0.7}
      >
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={1}>{title}</Text>
          <View style={styles.headerRight}>
            <Text style={styles.openText}>Open</Text>
            <Text style={styles.chevron}>{"\u203A"}</Text>
          </View>
        </View>

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

const styles = StyleSheet.create({
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
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  openText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  chevron: {
    color: colors.textMuted,
    fontSize: 14,
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
});
