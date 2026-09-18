import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "@clawtab/shared";

export function TerminalZoomControls({ fontSize, onChange }: {
  fontSize: number;
  onChange: (size: number) => void;
}) {
  return (
    <View style={styles.controls}>
      <TouchableOpacity
        style={styles.button}
        onPress={() => onChange(Math.max(9, fontSize - 1))}
        disabled={fontSize <= 9}
        accessibilityRole="button"
        accessibilityLabel="Decrease terminal text size"
      >
        <Text style={[styles.label, fontSize <= 9 && styles.disabled]}>A−</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.button}
        onPress={() => onChange(Math.min(22, fontSize + 1))}
        disabled={fontSize >= 22}
        accessibilityRole="button"
        accessibilityLabel="Increase terminal text size"
      >
        <Text style={[styles.label, fontSize >= 22 && styles.disabled]}>A+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  controls: { flexDirection: "row", alignItems: "center" },
  button: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  label: { color: colors.text, fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.35 },
});
