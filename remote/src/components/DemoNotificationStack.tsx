import { useState, useEffect } from "react";
import { View, StyleSheet } from "react-native";
import { NotificationSection } from "@clawtab/shared";
import { DEMO_QUESTIONS } from "../demo/data";
import { colors, spacing } from "@clawtab/shared";
import type { ClaudeQuestion } from "@clawtab/shared";

interface DemoNotificationStackProps {
  embedded?: boolean;
}

export function DemoNotificationStack({ embedded = false }: DemoNotificationStackProps) {
  const [visible, setVisible] = useState(embedded);

  useEffect(() => {
    if (embedded) return;
    const timer = setTimeout(() => setVisible(true), 1000);
    return () => clearTimeout(timer);
  }, [embedded]);

  if (!visible || DEMO_QUESTIONS.length === 0) return null;

  const resolveJob = (q: ClaudeQuestion) => q.matched_job ?? null;

  return (
    <View style={[styles.container, embedded && styles.embeddedContainer]}>
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
  embeddedContainer: {
    paddingBottom: 0,
    borderBottomWidth: 0,
    marginBottom: 0,
  },
});
