import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

export function HeaderBackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Ionicons name="chevron-back" size={24} color={colors.text} />
    </Pressable>
  );
}

export function HeaderStatusDot({ color }: { color: string }) {
  return (
    <View
      accessibilityRole="image"
      style={styles.statusButton}
    >
      <View style={[styles.statusDot, { backgroundColor: color }]} />
    </View>
  );
}

export function HeaderTitleWithIcon({
  title,
  icon,
}: {
  title: string;
  icon: ReactNode;
}) {
  return (
    <View style={styles.titleGroup}>
      <View style={styles.iconSlot}>{icon}</View>
      <Text style={styles.titleText} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.55,
  },
  statusButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  iconSlot: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  titleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
  },
  titleText: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
    minWidth: 0,
    flexShrink: 1,
  },
});
