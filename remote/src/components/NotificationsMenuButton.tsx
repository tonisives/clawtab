import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import { useRouter } from "expo-router";

import { colors } from "@clawtab/shared";
import { useNotificationStore } from "../store/notifications";
import { useResponsive } from "../hooks/useResponsive";

export function NotificationsMenuButton({
  hideWhenEmpty = false,
  variant = "compact",
  countOnly = false,
  onOpen,
  active = false,
}: {
  hideWhenEmpty?: boolean;
  variant?: "compact" | "fluid";
  countOnly?: boolean;
  onOpen?: () => void;
  active?: boolean;
}) {
  const router = useRouter();
  const { isSplitView } = useResponsive();
  const questions = useNotificationStore((s) => s.questions);

  const activeQuestionCount = questions.length;

  const openMenu = () => {
    if (onOpen) {
      onOpen();
    } else if (Platform.OS === "web" && isSplitView) {
      router.navigate({ pathname: "/(tabs)/(jobs)", params: { section: "notifications" } });
    } else {
      router.push("/notifications");
    }
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
      accessibilityState={{ selected: active }}
      accessibilityLabel={activeQuestionCount > 0 ? `${activeQuestionCount} active question${activeQuestionCount === 1 ? "" : "s"}` : "Notifications"}
      style={({ pressed }) => [
        countOnly ? [styles.countButton, activeQuestionCount === 0 && styles.countButtonEmpty] : glassAvailable ? styles.fluidGlassPressable : variant === "fluid" ? styles.fluidButton : styles.button,
        variant === "fluid" && activeQuestionCount > 0 && !glassAvailable && styles.fluidButtonHasQuestions,
        variant === "compact" && activeQuestionCount > 0 && !countOnly && styles.buttonHasQuestions,
        (pressed || active) && (glassAvailable ? styles.fluidGlassPressableActive : variant === "fluid" ? styles.fluidButtonActive : styles.buttonActive),
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
    <View style={countOnly ? styles.countButtonFrame : styles.buttonFrame}>
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
});
