import { useMemo, useRef, useState, type ComponentRef } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import WebView from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import { colors } from "@clawtab/shared";
import { terminalSelectionDocument } from "../lib/terminalSelectionDocument";

export function MessageTextSelection({ text, selection, bottom, onDone }: {
  text: string; selection?: { start: number; end: number }; bottom: number; onDone: () => void;
}) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const positioned = useRef(false);
  const [status, setStatus] = useState<string | null>(null);
  const source = useMemo(() => Platform.OS === "ios" ? undefined : { html: terminalSelectionDocument(text) }, [text]);
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.bg }}>
    <Text accessibilityLiveRegion="polite" style={{ color: colors.textMuted, fontSize: 14, lineHeight: 20, padding: 12 }}>
      {status ?? (text ? "Touch and hold to select text, then drag the handles and tap Copy." : "No text available in this message.")}
    </Text>
    {Platform.OS === "ios" ? <TextInput ref={input} accessibilityLabel="Message text" defaultValue={text} multiline editable={false}
      autoFocus={Boolean(selection)} showSoftInputOnFocus={false}
      onLayout={() => {
        if (!selection || positioned.current) return;
        positioned.current = true;
        input.current?.setSelection(selection.start, selection.end);
      }}
      autoCorrect={false} spellCheck={false} textAlignVertical="top"
      style={{ flex: 1, marginHorizontal: 12, paddingVertical: 12, paddingHorizontal: 0,
        color: colors.text, backgroundColor: colors.bg, fontSize: 13, lineHeight: 18,
        fontFamily: "Menlo" }} /> : <WebView source={source} style={{ flex: 1, marginHorizontal: 12, backgroundColor: colors.bg }}
          javaScriptEnabled={false} textInteractionEnabled scrollEnabled bounces dataDetectorTypes="none" />}
    <View style={{ flexDirection: "row", justifyContent: "space-between", padding: 12, paddingBottom: Math.max(12, bottom), gap: 12 }}>
      <Pressable accessibilityRole="button" disabled={!text} onPress={() => {
        void Clipboard.setStringAsync(text).then(() => setStatus("Text copied"), () => setStatus("Could not copy text. Try again."));
      }} style={({ pressed }) => ({ padding: 12, opacity: !text ? 0.4 : pressed ? 0.6 : 1 })}>
        <Text style={{ color: colors.accent, fontSize: 16, fontWeight: "600" }}>Copy all</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onDone} style={({ pressed }) => ({ padding: 12, opacity: pressed ? 0.6 : 1 })}>
        <Text style={{ color: colors.accent, fontSize: 16, fontWeight: "600" }}>Done</Text>
      </Pressable>
    </View>
  </View>;
}
