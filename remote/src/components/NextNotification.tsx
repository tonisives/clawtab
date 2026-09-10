import { useEffect, useRef } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, spacing, stripSeparators } from "@clawtab/shared";
import type { ClaudeQuestion } from "@clawtab/shared";
import { useNotificationStore } from "../store/notifications";

type NextNotificationProps = {
  paneId?: string;
  jobName?: string;
  onSelect: (question: ClaudeQuestion) => void;
};

export let NextNotification = ({ paneId, jobName, onSelect }: NextNotificationProps) => {
  let storedQuestions = useNotificationStore((state) => state.questions);
  let questions = storedQuestions;
  let currentIndex = questions.findIndex((question) => (
    paneId ? question.pane_id === paneId : question.matched_job === jobName
  ));
  let lastIndex = useRef(0);
  useEffect(() => {
    if (currentIndex >= 0) lastIndex.current = currentIndex;
  }, [currentIndex]);

  // When an answer removes the current question, its successor takes its slot.
  let startIndex = currentIndex >= 0 ? currentIndex + 1 : lastIndex.current;
  let nextQuestion: ClaudeQuestion | undefined;
  for (let offset = 0; offset < questions.length; offset += 1) {
    let question = questions[(startIndex + offset) % questions.length];
    let isCurrent = paneId ? question.pane_id === paneId : question.matched_job === jobName;
    if (!isCurrent) {
      nextQuestion = question;
      break;
    }
  }

  let handleSelect = () => {
    if (nextQuestion) onSelect(nextQuestion);
  };
  if (!nextQuestion) return null;

  let path = nextQuestion.cwd.replace(/^\/Users\/[^/]+/, "~")
    || nextQuestion.matched_job || nextQuestion.pane_id;
  // Keep terminal formatting and answer choices out of the short question preview.
  let lines = stripSeparators(nextQuestion.context_lines)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let preview = [...lines].reverse().find((line) => line.includes("?"))
    ?? lines.filter((line) => !/^[>❯]?\s*\d+[.)]\s/.test(line)).slice(-1)[0]
    ?? "Pending question";

  return (
    <SafeAreaView edges={["bottom"]} style={styles.container}>
      <Pressable
        style={styles.button}
        onPress={handleSelect}
        accessibilityRole="button"
        accessibilityLabel={`Next notification: ${path}. ${preview}`}
      >
        <View style={styles.content}>
          <Text style={styles.label}>Next notification</Text>
          <Text style={styles.path} numberOfLines={1} ellipsizeMode="middle">{path}</Text>
          <Text style={styles.question} numberOfLines={2}>{preview}</Text>
        </View>
        <Ionicons name="chevron-forward" size={22} color={colors.text} />
      </Pressable>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flexShrink: 0,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.md,
    minHeight: 72,
  },
  content: { flex: 1, minWidth: 0, gap: 3 },
  label: { color: colors.textMuted, fontSize: 11 },
  path: { color: colors.text, fontSize: 13, fontWeight: "600" },
  question: { color: colors.textSecondary, fontSize: 12 },
});
