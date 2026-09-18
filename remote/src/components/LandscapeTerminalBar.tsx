import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@clawtab/shared";

type Props = {
  topInset: number;
  onBack: () => void;
  title: ReactNode;
  actions?: ReactNode;
};

export function LandscapeTerminalBar({ topInset, onBack, title, actions }: Props) {
  return (
    <View style={[styles.bar, { paddingTop: topInset + 4 }]}>
      <Pressable onPress={onBack} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <View style={styles.title}>{title}</View>
      {actions}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    minHeight: 44,
    paddingBottom: 6,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: { minWidth: 36, minHeight: 36, justifyContent: "center" },
  title: { flex: 1, minWidth: 0 },
});
