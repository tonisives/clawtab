import { useCallback, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors } from "@clawtab/shared";
import { NextNotification } from "./NextNotification";
import type { ClaudeQuestion } from "@clawtab/shared";
import { JobDetailPane } from "./JobDetailPane";
import { ProcessDetailPane } from "./ProcessDetailPane";
import type { NotificationDetailTarget } from "./notificationTypes";
import { MessageInbox } from "./MessageInbox";

interface NotificationsPanelProps {
  mode: "popup" | "screen";
  onNavigateAway?: () => void;
  onBack?: () => void;
  onSelectDetail?: (target: NotificationDetailTarget) => void;
  detailTarget?: NotificationDetailTarget | null;
  onDetailTargetChange?: (target: NotificationDetailTarget | null) => void;
}

export function NotificationsPanel({
  mode,
  onNavigateAway,
  onBack,
  onSelectDetail,
  detailTarget: controlledDetailTarget,
  onDetailTargetChange,
}: NotificationsPanelProps) {
  const [localDetailTarget, setLocalDetailTarget] = useState<NotificationDetailTarget | null>(null);
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

  const closeDetail = onBack ?? (() => setDetailTarget(null));

  let handleSelectNextNotification = (question: ClaudeQuestion) => {
    if (question.matched_job) {
      setDetailTarget({ kind: "job", jobName: question.matched_job, paneId: question.pane_id });
      return;
    }
    setDetailTarget({
      kind: "process",
      paneId: question.pane_id,
    });
  };

  if (detailTarget) {
    return (
      <View style={styles.detailRoot}>
        {mode === "screen" && (
          <View style={styles.detailToolbar}>
            <Pressable
              onPress={closeDetail}
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
              embedded
              onClose={closeDetail}
            />
          ) : (
            <ProcessDetailPane
              key={`process-${detailTarget.paneId}`}
              paneId={detailTarget.paneId}
              embedded
              onClose={closeDetail}
            />
          )}
        </View>
        <NextNotification
          paneId={detailTarget.paneId}
          jobName={detailTarget.kind === "job" ? detailTarget.jobName : undefined}
          onSelect={handleSelectNextNotification}
        />
      </View>
    );
  }

  return <View style={{ flex: 1, minHeight: 0, backgroundColor: "#161616" }}>
    <MessageInbox onSelectDetail={setDetailTarget} onNavigateAway={onNavigateAway} />
  </View>;
}

const styles = StyleSheet.create({
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

});
