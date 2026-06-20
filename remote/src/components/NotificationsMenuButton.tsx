import { useMemo, useRef, useState } from "react";
import { Dimensions, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors } from "@clawtab/shared";
import { DEMO_QUESTIONS } from "../demo/data";
import { useJobsStore } from "../store/jobs";
import { useNotificationStore } from "../store/notifications";
import { useWsStore } from "../store/ws";
import { NotificationsPanel } from "./NotificationsPanel";

export function NotificationsMenuButton({
  hideWhenEmpty = false,
  variant = "compact",
}: {
  hideWhenEmpty?: boolean;
  variant?: "compact" | "fluid";
}) {
  const router = useRouter();
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
    if (Platform.OS === "ios") {
      router.push("/notifications");
      return;
    }

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

  const glassAvailable = variant === "fluid" && Platform.OS === "ios" && (() => {
    try {
      return isGlassEffectAPIAvailable();
    } catch {
      return false;
    }
  })();

  const buttonContent = (
    <Pressable
      onPress={openMenu}
      accessibilityRole="button"
      accessibilityLabel={activeQuestionCount > 0 ? `${activeQuestionCount} active question${activeQuestionCount === 1 ? "" : "s"}` : "Notifications"}
      style={({ pressed }) => [
        glassAvailable ? styles.fluidGlassPressable : variant === "fluid" ? styles.fluidButton : styles.button,
        variant === "fluid" && activeQuestionCount > 0 && !glassAvailable && styles.fluidButtonHasQuestions,
        variant === "compact" && activeQuestionCount > 0 && styles.buttonHasQuestions,
        (pressed || open) && (glassAvailable ? styles.fluidGlassPressableActive : variant === "fluid" ? styles.fluidButtonActive : styles.buttonActive),
      ]}
    >
      <Ionicons
        name={activeQuestionCount > 0 ? "notifications" : "notifications-outline"}
        size={variant === "fluid" ? 18 : 17}
        color={activeQuestionCount > 0 ? colors.warning : colors.textMuted}
      />
      {activeQuestionCount > 0 && (
        <View style={variant === "fluid" ? styles.fluidBadge : styles.badge}>
          <Text style={variant === "fluid" ? styles.fluidBadgeText : styles.badgeText}>{activeQuestionCount}</Text>
        </View>
      )}
    </Pressable>
  );

  return (
    <View ref={buttonRef} collapsable={false} style={styles.buttonFrame}>
      {glassAvailable ? (
        <GlassView
          glassEffectStyle="regular"
          isInteractive
          colorScheme="dark"
          style={styles.fluidGlass}
        >
          {buttonContent}
        </GlassView>
      ) : buttonContent}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
          <View style={[styles.popup, Platform.OS !== "web" && styles.nativePopup, isDemo && styles.demoPopup, popupFrame]}>
            <Text style={styles.title}>Notifications</Text>
            <NotificationsPanel mode="popup" onNavigateAway={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  buttonFrame: {
    transform: [{ translateY: 3 }],
  },
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
    width: 42,
    height: 42,
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
  fluidGlass: {
    width: 42,
    height: 42,
    borderRadius: 999,
    overflow: "hidden",
  },
  fluidGlassPressable: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    position: "relative",
  },
  fluidGlassPressableActive: {
    transform: [{ scale: 0.97 }],
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
    top: 3,
    right: 3,
    minWidth: 14,
    height: 14,
    paddingHorizontal: 3,
    borderRadius: 7,
    backgroundColor: colors.warning,
    alignItems: "center",
    justifyContent: "center",
  },
  fluidBadgeText: {
    color: colors.bg,
    fontSize: 8,
    lineHeight: 10,
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
  demoPopup: {
    ...(Platform.OS === "web"
      ? {
          width: Math.min(520, Dimensions.get("window").width - 20),
          maxHeight: Math.min(720, Dimensions.get("window").height * 0.82),
        }
      : null),
  },
  title: {
    marginBottom: 8,
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
});
