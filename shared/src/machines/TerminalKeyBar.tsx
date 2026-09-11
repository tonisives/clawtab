import { Pressable, StyleSheet, Text, View } from "react-native"
import { colors } from "../theme/colors"

let keys = [
  { label: "Escape", text: "Esc", value: "\x1b" },
  { label: "Control C", text: "C-c", value: "\x03" },
  { label: "Arrow left", direction: "left", value: "\x1b[D" },
  { label: "Arrow down", direction: "down", value: "\x1b[B" },
  { label: "Arrow up", direction: "up", value: "\x1b[A" },
  { label: "Arrow right", direction: "right", value: "\x1b[C" },
  { label: "Enter", text: "Enter", value: "\r" },
] as const

export let TerminalKeyBar = ({ onKey, disabled }: { onKey: (value: string) => void; disabled: boolean }) => <View style={styles.bar}>
  {keys.map((key) => {
    let press = () => { if (!disabled) onKey(key.value) }
    return <Pressable key={key.label} accessibilityRole="button" accessibilityLabel={key.label} accessibilityState={{ disabled }} disabled={disabled} onPress={press} style={[styles.button, disabled && styles.disabled]}>
      {"direction" in key ? <View style={[styles.chevron, styles[key.direction]]} /> : <Text style={styles.text}>{key.text}</Text>}
    </Pressable>
  })}
</View>

let styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 8 },
  button: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 999, backgroundColor: colors.groupedSurface, borderWidth: 1, borderColor: colors.border },
  disabled: { opacity: 0.4 },
  text: { color: colors.text, fontSize: 12, fontWeight: "600" },
  chevron: { width: 9, height: 9, borderRightWidth: 2, borderTopWidth: 2, borderColor: colors.text },
  left: { transform: [{ rotate: "-135deg" }] },
  down: { transform: [{ rotate: "135deg" }] },
  up: { transform: [{ rotate: "-45deg" }] },
  right: { transform: [{ rotate: "45deg" }] },
})
