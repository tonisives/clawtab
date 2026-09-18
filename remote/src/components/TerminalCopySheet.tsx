import * as Clipboard from "expo-clipboard";
import { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { colors } from "@clawtab/shared";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
})[character] ?? character);

const copyHtml = (value: string) => `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>
html,body{margin:0;min-height:100%;background:${colors.bg};color:${colors.text}}
body{padding:12px 0;font:13px/18px Menlo,monospace;-webkit-user-select:text;user-select:text;-webkit-touch-callout:default}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}
</style></head><body><pre>${escapeHtml(value)}</pre></body></html>`;

type TerminalCopySheetProps = {
  text: string | null;
  onClose: () => void;
};

export let TerminalCopySheet = ({ text, onClose }: TerminalCopySheetProps) => {
  let insets = useSafeAreaInsets();
  let { width, height } = useWindowDimensions();
  let isLandscape = width > height;
  let source = useMemo(() => ({ html: copyHtml(text ?? "") }), [text]);

  let handleCopyAll = () => {
    if (text) void Clipboard.setStringAsync(text);
    onClose();
  };

  return (
    <Modal visible={text !== null} transparent animationType="slide" supportedOrientations={["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]} onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, isLandscape && styles.landscapeSheet, {
          paddingTop: isLandscape ? Math.max(insets.top, 12) : 16,
          paddingBottom: Math.max(insets.bottom, 16),
          paddingLeft: Math.max(insets.left, 16),
          paddingRight: Math.max(insets.right, 16),
        }]}>
          <View style={styles.header}>
            <Text style={styles.title}>Terminal text</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close terminal text">
              <Text style={styles.action}>Done</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>Touch and hold to select a passage, then drag the handles and tap Copy.</Text>
          <WebView
            style={styles.textView}
            source={source}
            javaScriptEnabled={false}
            textInteractionEnabled
            scrollEnabled
            bounces
            dataDetectorTypes="none"
          />
          <Pressable
            style={styles.copyButton}
            accessibilityRole="button"
            accessibilityLabel="Copy all visible terminal text"
            onPress={handleCopyAll}
          >
            <Text style={styles.copyButtonText}>Copy all visible text</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: { height: "85%", backgroundColor: colors.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  landscapeSheet: { height: "100%", borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  action: { color: colors.accent, fontSize: 16, padding: 8 },
  hint: { color: colors.textMuted, marginTop: 8, marginBottom: 12 },
  textView: { flex: 1, minHeight: 0, backgroundColor: colors.bg },
  copyButton: { backgroundColor: colors.accent, alignItems: "center", padding: 13, borderRadius: 8, marginTop: 12 },
  copyButtonText: { color: colors.text, fontWeight: "600" },
});
