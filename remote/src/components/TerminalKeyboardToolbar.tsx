import { useCallback } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@clawtab/shared";
import { TerminalPasteButton } from "./TerminalPasteButton";

export const TERMINAL_KEYBOARD_TOOLBAR_HEIGHT = 48;

type Props = {
  bottom: number;
  onDismiss: () => void;
  onSend: (text: string) => void;
  onWrite: () => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
};

export function TerminalKeyboardToolbar({ bottom, onDismiss, onSend, onWrite, menuOpen, onMenuOpenChange }: Props) {
  const closeMenu = useCallback(() => onMenuOpenChange(false), [onMenuOpenChange]);
  return (
    <View style={[styles.toolbar, { bottom }]}>
      <TouchableOpacity style={styles.button} onPress={onDismiss} accessibilityLabel="Dismiss keyboard">
        <Ionicons name="chevron-down" size={20} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.wideButton} onPress={() => onSend("\x1b")}><Text style={styles.buttonText}>Esc</Text></TouchableOpacity>
      <TouchableOpacity style={styles.wideButton} onPress={() => onSend("\x03")}><Text style={styles.buttonText}>C-c</Text></TouchableOpacity>
      <View style={styles.spacer} />
      <TouchableOpacity style={styles.button} onPress={() => onSend("\x1b[D")} accessibilityLabel="Left arrow"><Ionicons name="chevron-back" size={20} color={colors.text} /></TouchableOpacity>
      <TouchableOpacity style={styles.button} onPress={() => onSend("\x1b[B")} accessibilityLabel="Down arrow"><Ionicons name="chevron-down" size={20} color={colors.text} /></TouchableOpacity>
      <TouchableOpacity style={styles.button} onPress={() => onSend("\x1b[A")} accessibilityLabel="Up arrow"><Ionicons name="chevron-up" size={20} color={colors.text} /></TouchableOpacity>
      <TouchableOpacity style={styles.button} onPress={() => onSend("\x1b[C")} accessibilityLabel="Right arrow"><Ionicons name="chevron-forward" size={20} color={colors.text} /></TouchableOpacity>
      <View style={styles.spacer} />
      <View style={styles.menuWrap}>
        <TouchableOpacity style={styles.button} onPress={() => onMenuOpenChange(!menuOpen)} accessibilityLabel="More keyboard actions">
          <Ionicons name="ellipsis-horizontal" size={20} color={colors.text} />
        </TouchableOpacity>
        {menuOpen ? (
          <View style={styles.popover}>
            <TerminalPasteButton onPaste={onSend} onDone={closeMenu} />
            <TouchableOpacity style={styles.writeButton} onPress={onWrite}><Text style={styles.writeText}>Write</Text></TouchableOpacity>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    position: "absolute", left: 0, right: 0, height: TERMINAL_KEYBOARD_TOOLBAR_HEIGHT,
    zIndex: 200, elevation: 200, flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 6, borderTopWidth: 1, borderBottomWidth: 1,
    borderColor: colors.border, backgroundColor: colors.surface,
  },
  button: { width: 36, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  wideButton: { minWidth: 44, height: 34, paddingHorizontal: 6, alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  buttonText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  spacer: { flex: 1 },
  menuWrap: { position: "relative", alignSelf: "center", zIndex: 220, elevation: 220 },
  popover: { position: "absolute", right: 0, bottom: 42, width: 164, padding: 12, alignItems: "center", gap: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, zIndex: 240, elevation: 240 },
  writeButton: { width: 120, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  writeText: { color: colors.text, fontSize: 15, fontWeight: "600" },
});
