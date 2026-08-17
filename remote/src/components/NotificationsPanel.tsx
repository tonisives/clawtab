import { useCallback, useMemo, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, radius, spacing } from "@clawtab/shared";
import { DEMO_QUESTIONS } from "../demo/data";
import { useJobsStore } from "../store/jobs";
import { useNotificationStore } from "../store/notifications";
import { useWsStore } from "../store/ws";
import { DemoNotificationStack } from "./DemoNotificationStack";
import { JobDetailPane } from "./JobDetailPane";
import { ProcessDetailPane } from "./ProcessDetailPane";
import { NotificationStack } from "./NotificationStack";
import type { NotificationDetailTarget } from "./notificationTypes";

interface NotificationsPanelProps {
  mode: "popup" | "screen";
  onNavigateAway?: () => void;
  onSelectDetail?: (target: NotificationDetailTarget) => void;
  detailTarget?: NotificationDetailTarget | null;
  onDetailTargetChange?: (target: NotificationDetailTarget | null) => void;
}

export function NotificationsPanel({
  mode,
  onNavigateAway,
  onSelectDetail,
  detailTarget: controlledDetailTarget,
  onDetailTargetChange,
}: NotificationsPanelProps) {
  const windowSize = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const questions = useNotificationStore((s) => s.questions);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const realJobs = useJobsStore((s) => s.jobs);
  const connected = useWsStore((s) => s.connected);
  const desktopOnline = useWsStore((s) => s.desktopOnline);
  const isDemo = connected && !desktopOnline && realJobs.length === 0;
  const [localDetailTarget, setLocalDetailTarget] = useState<NotificationDetailTarget | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const detailTarget = onDetailTargetChange !== undefined
    ? controlledDetailTarget ?? null
    : localDetailTarget;
  const setDetailTarget = useCallback((target: NotificationDetailTarget | null) => {
    if (target && onSelectDetail) {
      onSelectDetail(target);
      return;
    }
    if (onDetailTargetChange) {
      onDetailTargetChange(target);
    } else {
      setLocalDetailTarget(target);
    }
  }, [onDetailTargetChange, onSelectDetail]);

  const handlePanelLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    setPanelHeight((previousHeight) => (
      Math.abs(previousHeight - nextHeight) > 1 ? nextHeight : previousHeight
    ));
  }, []);

  const activeQuestionCount = useMemo(() => {
    if (isDemo) return DEMO_QUESTIONS.length;

    return questions.length;
  }, [isDemo, questions]);

  const hasContent = activeQuestionCount > 0 || (!isDemo && autoYesPaneIds.size > 0);
  const nativeTop = insets.top + 58;
  const nativeBottom = insets.bottom + 58;
  const nativeAvailableHeight = Math.max(260, windowSize.height - nativeTop - nativeBottom - 24);
  const estimatedScreenHeight = Math.max(0, windowSize.height - insets.top - insets.bottom);
  const nativeScreenAvailableHeight = panelHeight > 0 ? panelHeight : estimatedScreenHeight;
  const nativeScreenReserve = 84
    + (activeQuestionCount > 1 ? 40 : 0)
    + (!isDemo && autoYesPaneIds.size > 0 ? 42 : 0);
  const nativeScreenCardMinHeight = Math.min(
    windowSize.height,
    Math.max(420, nativeScreenAvailableHeight - nativeScreenReserve),
  );
  const nativeCardMinHeight = mode === "popup"
    ? Math.max(240, nativeAvailableHeight - 120)
    : nativeScreenCardMinHeight;
  const cardBottomInset = Platform.OS === "web" || mode !== "screen" ? 0 : insets.bottom;
  // React Native exposes the safe-area inset, but not the device's hardware
  // screen-corner radius. 44pt is the common iPhone display corner radius.
  const cardBottomRadius = Platform.OS === "ios" && !Platform.isPad ? 44 : radius.lg;

  if (detailTarget) {
    return (
      <View style={styles.detailRoot}>
        {mode === "screen" && (
          <View style={styles.detailToolbar}>
            <Pressable
              onPress={() => setDetailTarget(null)}
              style={styles.detailBackButton}
              accessibilityRole="button"
              accessibilityLabel="Back to notifications"
            >
              <Ionicons name="chevron-back" size={18} color={colors.text} />
              <Text style={styles.detailBackText}>Notifications</Text>
            </Pressable>
            <Text style={styles.detailTitle}>Details</Text>
            <View style={styles.detailToolbarSpacer} />
          </View>
        )}
        <View style={styles.detailContent}>
          {detailTarget.kind === "job" ? (
            <JobDetailPane
              key={`job-${detailTarget.jobName}`}
              jobName={detailTarget.jobName}
              isDemo={detailTarget.isDemo ?? false}
              embedded
              onClose={() => setDetailTarget(null)}
            />
          ) : (
            <ProcessDetailPane
              key={`process-${detailTarget.paneId}`}
              paneId={detailTarget.paneId}
              demoProcess={detailTarget.demoProcess}
              embedded
              onClose={() => setDetailTarget(null)}
            />
          )}
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      onLayout={handlePanelLayout}
      contentContainerStyle={[
        styles.content,
        mode === "screen" && styles.screenContent,
        isDemo && styles.demoContent,
      ]}
    >
      {hasContent ? (
        isDemo ? (
          <DemoNotificationStack
            embedded
            cardMinHeight={Platform.OS === "web" ? undefined : nativeCardMinHeight}
            cardBottomInset={cardBottomInset}
            cardBottomRadius={cardBottomRadius}
            onSelectDetail={setDetailTarget}
          />
        ) : (
          <NotificationStack
            embedded
            cardMinHeight={Platform.OS === "web" ? undefined : nativeCardMinHeight}
            cardBottomInset={cardBottomInset}
            cardBottomRadius={cardBottomRadius}
            onNavigateAway={onNavigateAway}
            onSelectDetail={setDetailTarget}
            maxAutoYesEntries={Platform.OS === "web" ? undefined : 1}
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
  detailRoot: {
    flex: 1,
    minHeight: 0,
  },
  detailToolbar: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  detailBackButton: {
    minWidth: 92,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
  },
  detailBackText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  detailTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  detailToolbarSpacer: {
    width: 92,
    height: 44,
  },
  detailContent: {
    flex: 1,
    minHeight: 0,
  },
  empty: {
    padding: spacing.md,
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: "center",
  },
});
