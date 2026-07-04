import { useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NotificationsMenuButton } from "../../../src/components/NotificationsMenuButton";
import { colors } from "../../../src/theme/colors";
import SettingsScreen from "../settings";

export function WideHeaderActions() {
  const pathname = usePathname();
  const settingsActive = pathname === "/settings";
  const insets = useSafeAreaInsets();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <View style={styles.actions}>
      <NotificationsMenuButton />
      <Pressable
        onPress={() => setSettingsOpen(true)}
        style={[styles.actionButton, (settingsActive || settingsOpen) && styles.actionButtonActive]}
        accessibilityRole="button"
        accessibilityLabel="Settings"
      >
        <Ionicons
          name={settingsActive || settingsOpen ? "settings" : "settings-outline"}
          size={18}
          color={settingsActive || settingsOpen ? colors.accent : colors.textMuted}
        />
      </Pressable>
      <Modal
        visible={settingsOpen}
        transparent={Platform.OS === "web"}
        animationType="slide"
        presentationStyle={Platform.OS === "web" ? "overFullScreen" : "fullScreen"}
        statusBarTranslucent
        onRequestClose={() => setSettingsOpen(false)}
      >
        <View
          style={[
            styles.fullScreenModal,
            { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
          ]}
        >
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Settings</Text>
            <Pressable onPress={() => setSettingsOpen(false)} style={styles.modalCloseButton}>
              <Ionicons name="close" size={20} color={colors.text} />
            </Pressable>
          </View>
          <View style={styles.modalBody}>
            <SettingsScreen inModal />
          </View>
        </View>
      </Modal>
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
  modalCloseButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalBody: {
    flex: 1,
    overflow: "hidden",
  },
});
