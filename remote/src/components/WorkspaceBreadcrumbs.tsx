import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@clawtab/shared";

type Props = {
  title: string;
  actions?: ReactNode;
  notifications?: boolean;
  onMain?: () => void;
  onNotifications?: () => void;
};

export function WorkspaceBreadcrumbs({ title, actions, notifications, onMain, onNotifications }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const fromNotifications = notifications ?? pathname.startsWith("/notifications/");
  return (
    <View role="navigation" accessibilityLabel="Workspace navigation" style={styles.bar}>
      <Pressable accessibilityRole="link" accessibilityLabel="Show jobs and tabs"
        onPress={onMain ?? (() => router.dismissTo("/(tabs)"))}
        style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
        <Ionicons name="menu-outline" size={24} color={colors.accent} />
      </Pressable>
      {fromNotifications && <>
        <Text style={styles.separator}>/</Text>
        <Pressable accessibilityRole="link" onPress={onNotifications ?? (() => router.dismissTo("/notifications"))}
          style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
          <Text style={styles.linkText}>Notifications</Text>
        </Pressable>
      </>}
      <Text style={styles.separator}>/</Text>
      <Text numberOfLines={1} style={styles.current}>{title}</Text>
      {actions}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, backgroundColor: colors.bg, borderBottomWidth: 1, borderBottomColor: colors.border },
  link: { paddingVertical: 8, paddingHorizontal: 4, borderRadius: 4 },
  pressed: { backgroundColor: colors.surface },
  linkText: { color: colors.accent, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  separator: { color: colors.textMuted, fontSize: 14 },
  current: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: "600" },
});
