import { useEffect, useRef } from "react";
import { Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";

export function AgentLaunchAlert({ message, docsUrl, onClose }: {
  message: string;
  docsUrl?: string;
  onClose: () => void;
}) {
  const closeButton = useRef<any>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    closeButton.current?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [onClose]);

  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.overlay}>
      <View style={styles.content} accessibilityRole="alert" accessibilityViewIsModal>
        <Text style={styles.title}>Could not add agent</Text>
        <Text style={styles.message}>{message}</Text>
        <View style={styles.actions}>
          {docsUrl && <Pressable accessibilityRole="link" onPress={() => { void Linking.openURL(docsUrl); }} style={styles.button}>
            <Text style={styles.action}>Workspace limits</Text>
          </Pressable>}
          <Pressable ref={closeButton} accessibilityRole="button" onPress={onClose} style={styles.button}>
            <Text style={styles.action}>OK</Text>
          </Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: spacing.lg },
  content: { backgroundColor: colors.surface, borderRadius: 16, padding: spacing.lg, width: "100%", maxWidth: 400 },
  title: { color: colors.text, fontSize: 18, lineHeight: 28, fontWeight: "600", marginBottom: spacing.sm },
  message: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.lg },
  button: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  action: { color: colors.accent, fontSize: 14, lineHeight: 20, fontWeight: "600" },
});
