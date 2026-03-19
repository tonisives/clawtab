import { View, Text, Pressable, StyleSheet } from "react-native";
import { openUrl } from "../lib/platform";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export function DemoBanner() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Demo - Desktop not connected</Text>
      <Text style={styles.text}>
        Please install ClawTab desktop and sign in to same account.
      </Text>
      <Pressable onPress={() => openUrl("https://clawtab.cc/docs#quick-start")}>
        <Text style={styles.link}>Quick Start Guide</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  title: {
    color: colors.warning,
    fontSize: 15,
    fontWeight: "600",
  },
  text: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: "center",
  },
  link: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "500",
  },
});
