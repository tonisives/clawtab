import { useMemo } from "react";
import { Platform, ScrollView, StyleSheet, Text, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, spacing } from "@clawtab/shared";
import { DEMO_QUESTIONS } from "../demo/data";
import { useJobsStore } from "../store/jobs";
import { useNotificationStore } from "../store/notifications";
import { useWsStore } from "../store/ws";
import { DemoNotificationStack } from "./DemoNotificationStack";
import { NotificationStack } from "./NotificationStack";

interface NotificationsPanelProps {
  mode: "popup" | "screen";
  onNavigateAway?: () => void;
}

export function NotificationsPanel({ mode, onNavigateAway }: NotificationsPanelProps) {
  const windowSize = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const questions = useNotificationStore((s) => s.questions);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const realJobs = useJobsStore((s) => s.jobs);
  const connected = useWsStore((s) => s.connected);
  const desktopOnline = useWsStore((s) => s.desktopOnline);
  const isDemo = connected && !desktopOnline && realJobs.length === 0;

  const activeQuestionCount = useMemo(() => {
    if (isDemo) return DEMO_QUESTIONS.length;

    return questions.length;
  }, [isDemo, questions]);

  const hasContent = activeQuestionCount > 0 || (!isDemo && autoYesPaneIds.size > 0);
  const nativeTop = insets.top + 58;
  const nativeBottom = insets.bottom + 58;
  const nativeAvailableHeight = Math.max(260, windowSize.height - nativeTop - nativeBottom - 24);
  const nativeCardMinHeight = mode === "popup" ? Math.max(240, nativeAvailableHeight - 120) : undefined;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[
        styles.content,
        mode === "screen" && styles.screenContent,
        isDemo && styles.demoContent,
      ]}
    >
      {hasContent ? (
        isDemo ? <DemoNotificationStack embedded /> : (
          <NotificationStack
            embedded
            cardMinHeight={Platform.OS === "web" ? undefined : nativeCardMinHeight}
            onNavigateAway={onNavigateAway}
          />
        )
      ) : (
        <Text style={styles.empty}>No pending questions.</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
  },
  screenContent: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  demoContent: {
    minHeight: 280,
  },
  empty: {
    padding: spacing.md,
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: "center",
  },
});
