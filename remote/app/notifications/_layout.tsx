import { useMemo } from "react";
import { Platform, Pressable, StyleSheet } from "react-native";
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
    ...(Platform.OS === "ios" ? {
      unstable_headerRightItems: () => [{
        type: "button" as const, label: "Close notifications",
        icon: { type: "sfSymbol" as const, name: "xmark" as const },
        onPress: () => router.dismissTo("/(tabs)"),
      }],
    } : { headerRight: () => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close notifications"
        hitSlop={12}
        onPress={() => router.dismissTo("/(tabs)")}
        style={styles.closeButton}
      >
        <Ionicons name="close" size={22} color={colors.text} />
      </Pressable>
    ) }),
  }), [router]);

  return (
    <Stack
      screenOptions={{
        animation: "none",
        contentStyle: styles.content,
      }}
    >
      <Stack.Screen name="index" options={listHeaderOptions} />
      <Stack.Screen name="message/[id]" options={{ ...listHeaderOptions, title: "Message" }} />
      <Stack.Screen name="job/[name]" options={{ gestureEnabled: true, fullScreenGestureEnabled: true }} />
      <Stack.Screen name="process/[pane_id]" options={{ gestureEnabled: true, fullScreenGestureEnabled: true }} />
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
  },
});
