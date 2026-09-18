import * as Clipboard from "expo-clipboard";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "@clawtab/shared";

export function TerminalCopySheet({ text, onClose }: { text: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={text !== null} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.header}>
            <Text style={styles.title}>Terminal text</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close terminal text">
              <Text style={styles.action}>Done</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>Select a passage, or copy all visible text.</Text>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <Text selectable style={styles.terminalText}>{text}</Text>
          </ScrollView>
          <Pressable
            style={styles.copyButton}
            accessibilityRole="button"
            accessibilityLabel="Copy all visible terminal text"
            onPress={() => {
              if (text) void Clipboard.setStringAsync(text);
              onClose();
            }}
          >
            <Text style={styles.copyButtonText}>Copy all visible text</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: { maxHeight: "85%", padding: 16, backgroundColor: colors.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  action: { color: colors.accent, fontSize: 16, padding: 8 },
  hint: { color: colors.textMuted, marginTop: 8, marginBottom: 12 },
  scroll: { flexGrow: 0 },
  content: { paddingVertical: 12 },
  terminalText: { color: colors.text, fontFamily: "Menlo", fontSize: 13, lineHeight: 18 },
  copyButton: { backgroundColor: colors.accent, alignItems: "center", padding: 13, borderRadius: 8, marginTop: 12 },
  copyButtonText: { color: colors.text, fontWeight: "600" },
});
