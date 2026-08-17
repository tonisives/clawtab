import { useMemo } from "react";
import { Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useRouter } from "expo-router";

import { colors } from "../../src/theme/colors";

export default function NotificationsLayout() {
  const router = useRouter();
  const listHeaderOptions = useMemo(() => ({
    title: "Notifications",
    headerStyle: { backgroundColor: colors.bg },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: "600" as const },
    headerShadowVisible: true,
    headerLeft: () => null,
    headerRight: () => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close notifications"
        hitSlop={12}
        onPress={() => router.dismiss()}
        style={styles.closeButton}
      >
        <Ionicons name="close" size={22} color={colors.text} />
      </Pressable>
    ),
  }), [router]);

  return (
    <Stack
      screenOptions={{
        animation: "slide_from_right",
        contentStyle: styles.content,
      }}
    >
      <Stack.Screen name="index" options={listHeaderOptions} />
      <Stack.Screen name="job/[name]" />
      <Stack.Screen name="process/[pane_id]" />
    </Stack>
  );
}

const styles = StyleSheet.create({
  content: {
    backgroundColor: colors.bg,
  },
  closeButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
});
