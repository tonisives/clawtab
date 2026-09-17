import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors } from "@clawtab/shared";

type Props = {
  visible: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onClose: () => void;
  onDone: () => void;
};

export function TerminalWriteDialog({ visible, draft, onDraftChange, onClose, onDone }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" presentationStyle="overFullScreen" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.dialog}>
          <Text style={styles.title}>Write to terminal</Text>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={onDraftChange}
            autoFocus
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            placeholder="Type a response or command"
            placeholderTextColor={colors.textMuted}
          />
          <View style={styles.actions}>
            <Pressable onPress={onClose} style={styles.action}><Text style={styles.actionText}>Cancel</Text></Pressable>
            <Pressable onPress={onDone} style={styles.action} disabled={!draft.length}><Text style={[styles.actionText, !draft.length && styles.disabled]}>Done</Text></Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "#0009", alignItems: "center", justifyContent: "center", padding: 24 },
  dialog: { width: "100%", maxWidth: 420, backgroundColor: colors.surface, borderRadius: 14, paddingTop: 20, overflow: "hidden" },
  title: { color: colors.text, fontSize: 17, fontWeight: "600", textAlign: "center", marginBottom: 16 },
  input: { color: colors.text, backgroundColor: colors.bg, borderRadius: 8, minHeight: 110, maxHeight: 230, marginHorizontal: 16, padding: 12, fontSize: 16, textAlignVertical: "top" },
  actions: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.border, marginTop: 20 },
  action: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center" },
  actionText: { color: colors.accent, fontSize: 17, fontWeight: "600" },
  disabled: { opacity: 0.4 },
});
