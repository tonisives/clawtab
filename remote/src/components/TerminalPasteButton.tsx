import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text } from "react-native";
import * as Clipboard from "expo-clipboard";
import { colors } from "@clawtab/shared";
import { alertError } from "../lib/platform";

type Props = { onPaste: (text: string) => void; onDone: () => void };

export let TerminalPasteButton = ({ onPaste, onDone }: Props) => {
  let [reading, setReading] = useState(false);
  let acceptText = (text: string) => {
    if (!text) return;
    onPaste(text);
    onDone();
  };
  let handleNativePaste = (event: Clipboard.PasteEventPayload) => {
    if (event.type === "text") acceptText(event.text);
  };
  let handlePress = async () => {
    if (reading) return;
    setReading(true);
    try {
      acceptText(await Clipboard.getStringAsync());
    } catch {
      alertError("Paste failed", "Use the keyboard paste action or allow clipboard access and try again.");
    } finally {
      setReading(false);
    }
  };
  if (Platform.OS === "ios" && Clipboard.isPasteButtonAvailable) {
    return <Clipboard.ClipboardPasteButton style={styles.nativeButton} acceptedContentTypes={["plain-text"]} onPress={handleNativePaste} />;
  }
  return <Pressable style={styles.button} onPress={handlePress} disabled={reading}><Text style={styles.label}>{reading ? "Pasting..." : "Paste"}</Text></Pressable>;
};

let styles = StyleSheet.create({
  nativeButton: { width: 120, height: 44 },
  button: { paddingHorizontal: 14, paddingVertical: 12 },
  label: { color: colors.text, fontSize: 15 },
});
