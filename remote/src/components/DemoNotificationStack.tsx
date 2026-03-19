import { useState, useEffect } from "react";
import { View, StyleSheet } from "react-native";
import { NotificationSection } from "@clawtab/shared";
import { DEMO_QUESTIONS } from "../demo/data";
import { colors, spacing } from "@clawtab/shared";
import type { ClaudeQuestion } from "@clawtab/shared";

export function DemoNotificationStack() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 1000);
    return () => clearTimeout(timer);
  }, []);

  if (!visible || DEMO_QUESTIONS.length === 0) return null;

  const resolveJob = (q: ClaudeQuestion) => q.matched_job ?? null;

  return (
    <View style={styles.container}>
      <NotificationSection
        questions={DEMO_QUESTIONS}
        resolveJob={resolveJob}
        onNavigate={() => {}}
        onSendOption={() => {}}
        collapsed={false}
        onToggleCollapse={() => {}}
        autoYesPaneIds={new Set()}
        onToggleAutoYes={() => {}}
        autoAnsweredIds={new Set()}
        answerResetMs={1000}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: spacing.md,
    opacity: 0.6,
  },
});
