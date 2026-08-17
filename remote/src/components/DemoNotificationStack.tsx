import { useState, useEffect } from "react";
import { View, StyleSheet } from "react-native";
import { NotificationSection } from "@clawtab/shared";
import { DEMO_PROCESSES, DEMO_QUESTIONS } from "../demo/data";
import { colors, spacing } from "@clawtab/shared";
import type { ClaudeQuestion } from "@clawtab/shared";
import type { NotificationDetailTarget } from "./notificationTypes";

interface DemoNotificationStackProps {
  embedded?: boolean;
  cardMinHeight?: number;
  onSelectDetail?: (target: NotificationDetailTarget) => void;
}

export function DemoNotificationStack({
  embedded = false,
  cardMinHeight = 260,
  onSelectDetail,
}: DemoNotificationStackProps) {
  const [visible, setVisible] = useState(embedded);

  useEffect(() => {
    if (embedded) return;
    const timer = setTimeout(() => setVisible(true), 1000);
    return () => clearTimeout(timer);
  }, [embedded]);

  if (!visible || DEMO_QUESTIONS.length === 0) return null;

  const resolveJob = (q: ClaudeQuestion) => q.matched_job ?? null;
  const handleNavigate = (q: ClaudeQuestion, resolvedJob: string | null) => {
    if (!onSelectDetail) return;
    if (resolvedJob) {
      onSelectDetail({ kind: "job", jobName: resolvedJob, paneId: q.pane_id, isDemo: true });
      return;
    }
    onSelectDetail({
      kind: "process",
      paneId: q.pane_id,
      demoProcess: DEMO_PROCESSES.find((process) => process.pane_id === q.pane_id),
    });
  };

  return (
    <View style={[styles.container, embedded && styles.embeddedContainer]}>
      <NotificationSection
        questions={DEMO_QUESTIONS}
        resolveJob={resolveJob}
        onNavigate={handleNavigate}
        onSendOption={() => {}}
        collapsed={false}
        onToggleCollapse={() => {}}
        autoYesPaneIds={new Set()}
        onToggleAutoYes={() => {}}
        autoAnsweredIds={new Set()}
        answerResetMs={1000}
        cardMinHeight={cardMinHeight}
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
  },
  embeddedContainer: {
    paddingBottom: 0,
    borderBottomWidth: 0,
    marginBottom: 0,
    minHeight: 260,
  },
});
