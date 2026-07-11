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

export type SidebarSection = "jobs" | "settings";

export function LiquidSectionSwitcher({
  activeSection,
  onChange,
  style,
}: {
  activeSection: SidebarSection;
  onChange: (section: SidebarSection) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const glassAvailable =
    Platform.OS === "ios" &&
    (() => {
      try {
        return isGlassEffectAPIAvailable();
      } catch {
        return false;
      }
    })();

  const segment = (
    <View
      style={[
        styles.shell,
        glassAvailable ? styles.shellGlass : null,
        style,
      ]}
    >
      {(["jobs", "settings"] as const).map((section) => {
        const active = activeSection === section;
        const label = section === "jobs" ? "Jobs" : "Settings";
        return (
          <Pressable
            key={section}
            onPress={() => onChange(section)}
            style={({ pressed }) => [
              styles.button,
              active && styles.buttonActive,
              pressed && styles.buttonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: active }}
          >
            <Ionicons
              name={
                section === "jobs"
                  ? active
                    ? "briefcase"
                    : "briefcase-outline"
                  : active
                    ? "settings"
                    : "settings-outline"
              }
              size={17}
              color={active ? colors.text : colors.textMuted}
            />
            <Text style={[styles.text, active && styles.textActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (!glassAvailable) return segment;

  return (
    <GlassView
      glassEffectStyle="regular"
      isInteractive
      colorScheme="dark"
      style={[styles.glass, style]}
    >
      {segment}
    </GlassView>
  );
}

const styles = StyleSheet.create({
  glass: {
    alignSelf: "stretch",
    borderRadius: 22,
    overflow: "hidden",
  },
  shell: {
    flexDirection: "row",
    gap: 3,
    padding: 3,
    borderRadius: 22,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  shellGlass: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  button: {
    flex: 1,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderRadius: 19,
  },
  buttonActive: {
    backgroundColor: "rgba(121, 134, 203, 0.38)",
  },
  buttonPressed: {
    opacity: 0.78,
  },
  text: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "700",
  },
  textActive: {
    color: colors.text,
  },
});
