import { useMemo } from "react";
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import { Ionicons } from "@expo/vector-icons";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { colors } from "@clawtab/shared";
import { DEMO_QUESTIONS } from "../demo/data";
import { useJobsStore } from "../store/jobs";
import { useNotificationStore } from "../store/notifications";
import { useWsStore } from "../store/ws";

export type IpadNavigationItem = "jobs" | "settings" | "search" | "notifications";
export type IpadBarSection = Exclude<IpadNavigationItem, "search">;

export function IpadBottomBar({
  activeSection,
  onSelect,
  style,
}: {
  activeSection: IpadBarSection;
  onSelect: (item: IpadNavigationItem) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const questions = useNotificationStore((s) => s.questions);
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds);
  const realJobs = useJobsStore((s) => s.jobs);
  const connected = useWsStore((s) => s.connected);
  const desktopOnline = useWsStore((s) => s.desktopOnline);
  const isDemo = connected && !desktopOnline && realJobs.length === 0;
  const notificationCount = useMemo(
    () => (isDemo ? DEMO_QUESTIONS.length : questions.length),
    [isDemo, questions.length],
  );
  const hasAutoYes = !isDemo && autoYesPaneIds.size > 0;
  const glassAvailable =
    Platform.OS === "ios" &&
    (() => {
      try {
        return isGlassEffectAPIAvailable();
      } catch {
        return false;
      }
    })();

  const bar = (
    <View style={[styles.shell, glassAvailable ? styles.shellGlass : null, style]}>
      {(
        [
          {
            item: "jobs" as const,
            icon: "briefcase" as const,
            outline: "briefcase-outline" as const,
          },
          {
            item: "settings" as const,
            icon: "settings" as const,
            outline: "settings-outline" as const,
          },
          {
            item: "search" as const,
            icon: "search" as const,
            outline: "search-outline" as const,
          },
          {
            item: "notifications" as const,
            icon: "notifications" as const,
            outline: "notifications-outline" as const,
          },
        ]
      ).map(({ item, icon, outline }) => {
        const active = item !== "search" && activeSection === item;
        const hasNotification = item === "notifications" && notificationCount > 0;
        return (
          <Pressable
            key={item}
            onPress={() => onSelect(item)}
            style={({ pressed }) => [
              styles.button,
              active && styles.buttonActive,
              pressed && styles.buttonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={
              item === "notifications" ? "Notifications" : item[0].toUpperCase() + item.slice(1)
            }
            accessibilityState={{ selected: active }}
          >
            <Ionicons
              name={active || hasNotification ? icon : outline}
              size={21}
              color={hasNotification ? colors.warning : active ? colors.accent : colors.textMuted}
            />
            {hasNotification ? (
              <View style={styles.badge} pointerEvents="none">
                <Text style={styles.badgeText}>{notificationCount}</Text>
              </View>
            ) : hasAutoYes && item === "notifications" ? (
              <View style={styles.autoYesDot} pointerEvents="none" />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );

  if (!glassAvailable) return bar;

  return (
    <GlassView
      glassEffectStyle="regular"
      isInteractive
      colorScheme="dark"
      style={[styles.glass, style]}
    >
      {bar}
    </GlassView>
  );
}

const styles = StyleSheet.create({
  glass: {
    alignSelf: "stretch",
    borderRadius: 28,
    overflow: "hidden",
  },
  shell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    padding: 4,
    borderRadius: 28,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  shellGlass: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  button: {
    flex: 1,
    minWidth: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    position: "relative",
  },
  buttonActive: {
    backgroundColor: "rgba(121, 134, 203, 0.38)",
  },
  buttonPressed: {
    opacity: 0.76,
    transform: [{ scale: 0.96 }],
  },
  badge: {
    position: "absolute",
    top: 5,
    right: "27%",
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: colors.warning,
  },
  badgeText: {
    color: colors.bg,
    fontSize: 9,
    lineHeight: 11,
    fontWeight: "800",
  },
  autoYesDot: {
    position: "absolute",
    top: 8,
    right: "30%",
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
});
