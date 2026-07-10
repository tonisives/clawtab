import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import SettingsScreen from "../../app/(tabs)/settings";
import { colors } from "../theme/colors";
import { NotificationsMenuButton } from "./NotificationsMenuButton";

export function WideHeaderActions({ onOpenSettings }: { onOpenSettings: () => void }) {
  const pathname = usePathname();
  const settingsActive = pathname === "/settings";

  return (
    <View style={styles.actions}>
      <NotificationsMenuButton />
      <Pressable
        onPress={onOpenSettings}
        style={[styles.actionButton, settingsActive && styles.actionButtonActive]}
        accessibilityRole="button"
        accessibilityLabel="Settings"
      >
        <Ionicons
          name={settingsActive ? "settings" : "settings-outline"}
          size={18}
          color={settingsActive ? colors.accent : colors.textMuted}
        />
      </Pressable>
    </View>
  );
}

export function WideSettingsOverlay({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.settingsOverlay}>
      <View
        style={[
          styles.fullScreenModal,
          { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
        ]}
      >
        <View style={styles.modalHeader}>
          <Pressable
            onPress={onClose}
            style={styles.modalCloseButton}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close settings"
          >
            <Ionicons name="close" size={20} color={colors.text} />
          </Pressable>
          <Text style={styles.modalTitle}>Settings</Text>
          <View style={styles.modalHeaderSpacer} />
        </View>
        <View style={styles.modalBody}>
          <SettingsScreen inModal />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  actionButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionButtonActive: {
    backgroundColor: colors.accentBg,
    borderColor: "rgba(121, 134, 203, 0.32)",
  },
  settingsOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 1000,
    elevation: 1000,
    backgroundColor: colors.bg,
  },
  fullScreenModal: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 12,
  },
  modalHeader: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
  modalHeaderSpacer: {
    width: 44,
    height: 44,
  },
  modalCloseButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalBody: {
    flex: 1,
    minHeight: 0,
    ...(Platform.OS === "web" ? { overflow: "hidden" as const } : {}),
  },
});
