import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@clawtab/shared";
import { TerminalViewportControl } from "./TerminalViewportControl";

type Props = {
  fitSafeArea: boolean;
  onChangeViewport: (fitSafeArea: boolean) => void;
  onOpenDetails: () => void;
};

export function TerminalHeaderActions({ fitSafeArea, onChangeViewport, onOpenDetails }: Props) {
  return (
    <View style={styles.row}>
      <TerminalViewportControl fitSafeArea={fitSafeArea} onChange={onChangeViewport} />
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
