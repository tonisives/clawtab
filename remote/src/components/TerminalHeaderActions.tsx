import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@clawtab/shared";

type Props = {
  onZoom: () => void;
  zoomed?: boolean;
  onOpenDetails: () => void;
};

export function TerminalHeaderActions({ onZoom, zoomed = false, onOpenDetails }: Props) {
  return (
    <View style={styles.row}>
      <Pressable style={styles.button} onPress={onZoom} accessibilityRole="button" accessibilityLabel={zoomed ? "Fit shell to safe area" : "Zoom shell"}>
        <Ionicons name={zoomed ? "contract-outline" : "expand-outline"} size={20} color={colors.text} />
      </Pressable>
      <Pressable style={styles.button} onPress={onOpenDetails} accessibilityRole="button" accessibilityLabel="Shell details">
        <Ionicons name="ellipsis-horizontal" size={20} color={colors.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  button: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
});
