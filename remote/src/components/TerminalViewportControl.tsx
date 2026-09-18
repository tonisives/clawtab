import { StyleSheet, Text, TouchableOpacity } from "react-native";
import { colors } from "@clawtab/shared";

type TerminalViewportControlProps = {
  fitSafeArea: boolean;
  onChange: (fitSafeArea: boolean) => void;
};

export let TerminalViewportControl = ({ fitSafeArea, onChange }: TerminalViewportControlProps) => (
  <TouchableOpacity
    style={styles.button}
    onPress={() => onChange(!fitSafeArea)}
    accessibilityRole="button"
    accessibilityLabel={fitSafeArea ? "Fill screen with shell" : "Fit shell inside safe area"}
  >
    <Text style={styles.label}>{fitSafeArea ? "Fill" : "Fit"}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  button: {
    minWidth: 52,
    height: 36,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  label: { color: colors.text, fontSize: 14, fontWeight: "600" },
});
