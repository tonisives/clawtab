import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import WebView from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import { colors } from "@clawtab/shared";
import { messageSelectionLayout } from "../lib/messageSelectionLayout";
import { terminalSelectionDocument } from "../lib/terminalSelectionDocument";

const selectionFont = { color: colors.text, fontSize: 13, lineHeight: 18, fontFamily: "Menlo" };

// UIKit animates selection inside a scrollable UITextView. Fit the field to
// its text and position the outer scroller before revealing or focusing it.
function NativeSelection({ text, selection, onCopied }: { text: string; selection?: { start: number; end: number }; onCopied: () => void }) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const positioned = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const [initialSelection, setInitialSelection] = useState(selection);
  const [viewport, setViewport] = useState(0);
  const [layout, setLayout] = useState<ReturnType<typeof messageSelectionLayout> | null>(null);
  const [ready, setReady] = useState(false);
  return <View style={{ flex: 1, minHeight: 0 }} onLayout={event => setViewport(event.nativeEvent.layout.height)}>
    <Text accessible={false} accessibilityElementsHidden pointerEvents="none"
      style={{ ...selectionFont, position: "absolute", left: 12, right: 12, opacity: 0 }}
      onTextLayout={event => setLayout(messageSelectionLayout(text, selection?.start ?? 0, event.nativeEvent.lines))}>{text}</Text>
    {layout && viewport > 0 ? <ScrollView ref={scroll} accessibilityLabel="Message text scroll"
      style={{ flex: 1, marginHorizontal: 12, opacity: ready ? 1 : 0 }}
      contentInsetAdjustmentBehavior="never" automaticallyAdjustContentInsets={false}
      keyboardShouldPersistTaps="always"
      onContentSizeChange={(_, height) => {
        if (positioned.current) return;
        positioned.current = true;
        const y = selection ? Math.max(0, Math.min(height - viewport,
          layout.selectedY + layout.selectedHeight / 2 - viewport / 2)) : 0;
        scroll.current?.scrollTo({ y, animated: false });
        requestAnimationFrame(() => {
          setReady(true);
          if (selection) input.current?.focus();
        });
      }}>
      <TextInput ref={input} accessibilityLabel="Message text" defaultValue={text} multiline editable={false}
        scrollEnabled={false} showSoftInputOnFocus={false}
        onSelectionChange={event => {
          clearTimeout(copyTimer.current);
          const { start, end } = event.nativeEvent.selection;
          const selected = text.slice(start, end);
          if (selected.trim()) copyTimer.current = setTimeout(() => {
            void Clipboard.setStringAsync(selected).then(onCopied, () => {});
          }, 200);
        }}
        selection={initialSelection} onLayout={() => setInitialSelection(undefined)}
        autoCorrect={false} spellCheck={false} textAlignVertical="top"
        style={{ ...selectionFont, height: Math.max(viewport, layout.height), paddingVertical: 12, paddingHorizontal: 0,
          backgroundColor: colors.bg }} />
    </ScrollView> : null}
  </View>;
}

export function MessageTextSelection({ text, selection, bottom, onDone }: {
  text: string; selection?: { start: number; end: number }; bottom: number; onDone: () => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const showCopied = () => {
    clearTimeout(copiedTimer.current);
    setCopied(true);
    copiedTimer.current = setTimeout(() => setCopied(false), 1200);
  };
  const source = useMemo(() => Platform.OS === "ios" ? undefined : { html: terminalSelectionDocument(text) }, [text]);
  return <View style={{ flex: 1, minHeight: 0, position: "relative", backgroundColor: colors.bg }}>
    {!text ? <Text style={{ color: colors.textMuted, padding: 12 }}>No text available in this message.</Text> : null}
    {Platform.OS === "ios" ? <NativeSelection text={text} selection={selection} onCopied={showCopied} /> : <WebView source={source} style={{ flex: 1, marginHorizontal: 12, backgroundColor: colors.bg }}
          onMessage={event => {
            void Clipboard.setStringAsync(event.nativeEvent.data).then(showCopied, () => {});
          }}
          javaScriptEnabled textInteractionEnabled scrollEnabled bounces dataDetectorTypes="none" />}
    {copied ? <View pointerEvents="none" style={{ position: "absolute", top: 12, right: 12, zIndex: 2, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: "#4b4b4b", borderRadius: 6, backgroundColor: "#252525" }}>
      <Text accessibilityLiveRegion="polite" style={{ color: colors.text, fontSize: 12, fontWeight: "600" }}>copied</Text>
    </View> : null}
    <View style={{ flexDirection: "row", justifyContent: "space-between", padding: 12, paddingBottom: Math.max(12, bottom), gap: 12 }}>
      <Pressable accessibilityRole="button" disabled={!text} onPress={() => {
        void Clipboard.setStringAsync(text).then(() => { setStatus("Text copied"); showCopied(); }, () => setStatus("Could not copy text. Try again."));
      }} style={({ pressed }) => ({ padding: 12, opacity: !text ? 0.4 : pressed ? 0.6 : 1 })}>
        <Text accessibilityLiveRegion="polite" style={{ color: colors.accent, fontSize: 16, fontWeight: "600" }}>{status ?? "Copy all"}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onDone} style={({ pressed }) => ({ padding: 12, opacity: pressed ? 0.6 : 1 })}>
        <Text style={{ color: colors.accent, fontSize: 16, fontWeight: "600" }}>Done</Text>
      </Pressable>
    </View>
  </View>;
}
