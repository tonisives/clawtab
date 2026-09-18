import { StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
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
    <Ionicons name={fitSafeArea ? "expand-outline" : "contract-outline"} size={20} color={colors.text} />
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
});
