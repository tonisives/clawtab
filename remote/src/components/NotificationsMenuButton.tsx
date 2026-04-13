import { useMemo, useRef, useState } from "react";
import { Dimensions, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors, spacing } from "@clawtab/shared";
import { DEMO_QUESTIONS } from "../demo/data";
import { useJobsStore } from "../store/jobs";
import { useNotificationStore } from "../store/notifications";
import { useWsStore } from "../store/ws";
import { DemoNotificationStack } from "./DemoNotificationStack";
import { NotificationStack } from "./NotificationStack";

export function NotificationsMenuButton() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: 48, right: 12 });
  const buttonRef = useRef<View | null>(null);
  const questions = useNotificationStore((s) => s.questions);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const detectedProcesses = useJobsStore((s) => s.detectedProcesses);
  const realJobs = useJobsStore((s) => s.jobs);
  const connected = useWsStore((s) => s.connected);
  const desktopOnline = useWsStore((s) => s.desktopOnline);
  const isDemo = connected && !desktopOnline && realJobs.length === 0;

  const activeQuestionCount = useMemo(() => {
    if (isDemo) return DEMO_QUESTIONS.length;

    const processIds = new Set(detectedProcesses.map((proc) => proc.pane_id));
    return questions.filter((question) => processIds.has(question.pane_id) || question.matched_job != null).length;
  }, [detectedProcesses, isDemo, questions]);

  const hasContent = activeQuestionCount > 0 || (!isDemo && autoYesPaneIds.size > 0);

  const openMenu = () => {
    const screen = Dimensions.get("window");
    const node = buttonRef.current as unknown as {
      measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
      getBoundingClientRect?: () => DOMRect;
    } | null;

    if (Platform.OS === "web" && node?.getBoundingClientRect) {
      const rect = node.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, right: Math.max(10, screen.width - rect.right) });
    } else {
      node?.measureInWindow?.((x, y, width, height) => {
        setPosition({ top: y + height + 6, right: Math.max(10, screen.width - x - width) });
      });
    }

    setOpen((value) => !value);
  };

  return (
    <View ref={buttonRef} collapsable={false}>
      <Pressable
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel={activeQuestionCount > 0 ? `${activeQuestionCount} active question${activeQuestionCount === 1 ? "" : "s"}` : "Notifications"}
        style={({ pressed }) => [
          styles.button,
          (pressed || open) && styles.buttonActive,
          activeQuestionCount > 0 && styles.buttonHasQuestions,
        ]}
      >
        <Ionicons
          name={activeQuestionCount > 0 ? "notifications" : "notifications-outline"}
          size={17}
          color={activeQuestionCount > 0 ? colors.warning : colors.textMuted}
        />
        {activeQuestionCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>({activeQuestionCount})</Text>
          </View>
        )}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
          <View style={[styles.popup, { top: position.top, right: position.right }]}>
            <Text style={styles.title}>Notifications</Text>
            <ScrollView>
              {hasContent ? (
                isDemo ? <DemoNotificationStack embedded /> : <NotificationStack embedded />
              ) : (
                <Text style={styles.empty}>No pending questions.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    position: "relative",
  },
  buttonActive: {
    backgroundColor: colors.surfaceHover,
  },
  buttonHasQuestions: {
    backgroundColor: colors.warningBg,
  },
  badge: {
    position: "absolute",
    top: -5,
    right: -7,
    minWidth: 20,
    height: 14,
    paddingHorizontal: 4,
    borderRadius: 7,
    backgroundColor: colors.warning,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: colors.bg,
    fontSize: 9,
    lineHeight: 12,
    fontWeight: "700",
  },
  modalRoot: {
    flex: 1,
  },
  popup: {
    position: "absolute",
    width: Math.min(380, Dimensions.get("window").width - 20),
    maxHeight: Math.min(620, Dimensions.get("window").height * 0.7),
    padding: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.bg,
    overflow: "hidden",
    ...(Platform.OS === "web" ? { boxShadow: "0 18px 48px rgba(0, 0, 0, 0.35)" as any } : { elevation: 12 }),
  },
  title: {
    marginBottom: 8,
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  empty: {
    padding: spacing.md,
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: "center",
  },
});
