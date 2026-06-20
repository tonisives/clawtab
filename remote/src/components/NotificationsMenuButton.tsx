import { useMemo, useRef, useState } from "react";
import { Dimensions, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, spacing } from "@clawtab/shared";
import { DEMO_QUESTIONS } from "../demo/data";
import { useJobsStore } from "../store/jobs";
import { useNotificationStore } from "../store/notifications";
import { useWsStore } from "../store/ws";
import { DemoNotificationStack } from "./DemoNotificationStack";
import { NotificationStack } from "./NotificationStack";

export function NotificationsMenuButton({
  hideWhenEmpty = false,
  variant = "compact",
}: {
  hideWhenEmpty?: boolean;
  variant?: "compact" | "fluid";
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: 48, right: 12 });
  const windowSize = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const buttonRef = useRef<View | null>(null);
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
  const nativeCardMinHeight = Math.max(240, nativeAvailableHeight - 120);
  const popupFrame = Platform.OS === "web"
    ? {
        top: position.top,
        right: position.right,
        width: Math.min(560, windowSize.width - 20),
        maxHeight: Math.min(720, windowSize.height * 0.82),
      }
    : {
        top: nativeTop,
        right: 10,
        bottom: nativeBottom,
        left: 10,
      };

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

  if (hideWhenEmpty && activeQuestionCount === 0) {
    return null;
  }

  return (
    <View ref={buttonRef} collapsable={false}>
      <Pressable
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel={activeQuestionCount > 0 ? `${activeQuestionCount} active question${activeQuestionCount === 1 ? "" : "s"}` : "Notifications"}
        style={({ pressed }) => [
          variant === "fluid" ? styles.fluidButton : styles.button,
          variant === "fluid" && activeQuestionCount > 0 && styles.fluidButtonHasQuestions,
          variant === "compact" && activeQuestionCount > 0 && styles.buttonHasQuestions,
          (pressed || open) && (variant === "fluid" ? styles.fluidButtonActive : styles.buttonActive),
        ]}
      >
        <Ionicons
          name={activeQuestionCount > 0 ? "notifications" : "notifications-outline"}
          size={variant === "fluid" ? 20 : 17}
          color={activeQuestionCount > 0 ? colors.warning : colors.textMuted}
        />
        {activeQuestionCount > 0 && (
          <View style={variant === "fluid" ? styles.fluidBadge : styles.badge}>
            <Text style={variant === "fluid" ? styles.fluidBadgeText : styles.badgeText}>{activeQuestionCount}</Text>
          </View>
        )}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
          <View style={[styles.popup, Platform.OS !== "web" && styles.nativePopup, isDemo && styles.demoPopup, popupFrame]}>
            <Text style={styles.title}>Notifications</Text>
            <ScrollView
              style={styles.popupScroll}
              contentContainerStyle={[styles.popupScrollContent, isDemo && styles.demoNotificationContent]}
            >
              {hasContent ? (
                isDemo ? <DemoNotificationStack embedded /> : (
                  <NotificationStack
                    embedded
                    cardMinHeight={Platform.OS === "web" ? undefined : nativeCardMinHeight}
                    onNavigateAway={() => setOpen(false)}
                  />
                )
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
  fluidButton: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    position: "relative",
    backgroundColor: "rgba(24, 24, 24, 0.62)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.22)",
    shadowColor: "#000000",
    shadowOpacity: 0.28,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 14,
  },
  fluidButtonHasQuestions: {
    backgroundColor: "rgba(32, 30, 24, 0.68)",
    borderColor: "rgba(255, 210, 130, 0.34)",
    shadowColor: "#000000",
    shadowOpacity: 0.3,
  },
  fluidButtonActive: {
    transform: [{ scale: 0.97 }],
    backgroundColor: "rgba(42, 42, 42, 0.72)",
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
  fluidBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: colors.warning,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.42)",
  },
  fluidBadgeText: {
    color: colors.bg,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "800",
  },
  modalRoot: {
    flex: 1,
  },
  popup: {
    position: "absolute",
    padding: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.bg,
    overflow: "hidden",
    ...(Platform.OS === "web" ? { boxShadow: "0 18px 48px rgba(0, 0, 0, 0.35)" as any } : { elevation: 12 }),
  },
  nativePopup: {
    padding: 12,
  },
  popupScroll: {
    flex: 1,
  },
  popupScrollContent: {
    flexGrow: 1,
  },
  demoPopup: {
    ...(Platform.OS === "web"
      ? {
          width: Math.min(520, Dimensions.get("window").width - 20),
          maxHeight: Math.min(720, Dimensions.get("window").height * 0.82),
        }
      : null),
  },
  demoNotificationContent: {
    minHeight: 280,
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
