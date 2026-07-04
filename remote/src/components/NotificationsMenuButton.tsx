import { useMemo, useRef, useState } from "react";
import { Dimensions, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
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
  countOnly = false,
  showDemoQuestions = true,
}: {
  hideWhenEmpty?: boolean;
  variant?: "compact" | "fluid";
  countOnly?: boolean;
  showDemoQuestions?: boolean;
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
    if (isDemo && showDemoQuestions) return DEMO_QUESTIONS.length;

    return questions.length;
  }, [isDemo, questions, showDemoQuestions]);

  const hasContent = activeQuestionCount > 0 || (!isDemo && autoYesPaneIds.size > 0);
  const popupFrame = Platform.OS === "web"
    ? {
        top: position.top,
        right: position.right,
        width: Math.min(560, windowSize.width - 20),
        maxHeight: Math.min(720, windowSize.height * 0.82),
      }
    : {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
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
        countOnly ? [styles.countButton, activeQuestionCount === 0 && styles.countButtonEmpty] : glassAvailable ? styles.fluidGlassPressable : variant === "fluid" ? styles.fluidButton : styles.button,
        variant === "fluid" && activeQuestionCount > 0 && !glassAvailable && styles.fluidButtonHasQuestions,
        variant === "compact" && activeQuestionCount > 0 && !countOnly && styles.buttonHasQuestions,
        (pressed || open) && (glassAvailable ? styles.fluidGlassPressableActive : variant === "fluid" ? styles.fluidButtonActive : styles.buttonActive),
      ]}
    >
      {countOnly ? (
        activeQuestionCount > 0 ? (
          <Text style={styles.countButtonText}>{activeQuestionCount}</Text>
        ) : (
          <Ionicons name="checkmark-circle-outline" size={18} color={colors.textMuted} />
        )
      ) : (
        <Ionicons
          name={activeQuestionCount > 0 ? "notifications" : "notifications-outline"}
          size={variant === "fluid" ? 18 : 17}
          color={activeQuestionCount > 0 ? colors.warning : colors.textMuted}
        />
      )}
    </Pressable>
  );

  return (
    <View ref={buttonRef} collapsable={false} style={countOnly ? styles.countButtonFrame : styles.buttonFrame}>
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
      {activeQuestionCount > 0 && !countOnly && (
        <View
          pointerEvents="none"
          style={variant === "fluid" ? styles.fluidBadge : styles.badge}
        >
          <Text style={variant === "fluid" ? styles.fluidBadgeText : styles.badgeText}>{activeQuestionCount}</Text>
        </View>
      )}

      <Modal
        visible={open}
        transparent={Platform.OS === "web"}
        animationType={Platform.OS === "ios" ? "slide" : "fade"}
        presentationStyle={Platform.OS === "web" ? "overFullScreen" : "fullScreen"}
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.modalRoot}>
          {Platform.OS === "web" ? (
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
          ) : null}
          <View style={[styles.popup, Platform.OS !== "web" && [styles.nativePopup, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }], isDemo && styles.demoPopup, popupFrame]}>
            <View style={styles.modalHeader}>
              <Text style={styles.title}>Notifications</Text>
              <Pressable onPress={() => setOpen(false)} style={styles.closeButton}>
                <Ionicons name="close" size={20} color={colors.text} />
              </Pressable>
            </View>
            <NotificationsPanel mode="popup" onNavigateAway={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  buttonFrame: {
    position: "relative",
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  countButtonFrame: {
    position: "relative",
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  button: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    position: "relative",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonActive: {
    backgroundColor: colors.accentBg,
    borderColor: "rgba(121, 134, 203, 0.32)",
  },
  buttonHasQuestions: {
    backgroundColor: colors.warningBg,
    borderColor: "rgba(255, 159, 10, 0.28)",
  },
  countButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: colors.warning,
  },
  countButtonEmpty: {
    backgroundColor: "transparent",
  },
  countButtonText: {
    color: colors.bg,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
    textAlign: "center",
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
    top: -2,
    right: -4,
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
    top: -3,
    right: -5,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.warning,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    elevation: 2,
  },
  fluidBadgeText: {
    color: colors.bg,
    fontSize: 9,
    lineHeight: 12,
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
    paddingHorizontal: 12,
    borderWidth: 0,
    borderRadius: 0,
    elevation: 0,
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
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
  modalHeader: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  closeButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
});
