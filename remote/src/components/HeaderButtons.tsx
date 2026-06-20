import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { HeaderBackButton as NativeHeaderBackButton } from "expo-router/react-navigation";
import { colors } from "../theme/colors";

export function HeaderBackButton({ onPress }: { onPress: () => void }) {
  return (
    <NativeHeaderBackButton
      displayMode="minimal"
      tintColor={colors.text}
      onPress={onPress}
    />
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
  onPress,
}: {
  title: string;
  icon: ReactNode;
  onPress?: () => void;
}) {
  const content = (
    <>
      <View style={styles.iconSlot}>{icon}</View>
      <Text style={styles.titleText} numberOfLines={1}>
        {title}
      </Text>
    </>
  );
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={styles.titleGroup}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
