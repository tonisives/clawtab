import { StyleSheet, View } from "react-native";
import { colors } from "../theme/colors";

const TEETH = [0, 45, 90, 135];

export let SettingsIcon = () => (
  <View style={styles.icon} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {TEETH.map((angle) => <View key={angle} style={[styles.teeth, { transform: [{ rotate: `${angle}deg` }] }]} />)}
    <View style={styles.ring}><View style={styles.hole} /></View>
  </View>
);

let styles = StyleSheet.create({
  icon: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  teeth: { position: "absolute", width: 6, height: 20, borderRadius: 1, backgroundColor: colors.textSecondary },
  ring: { width: 15, height: 15, borderRadius: 8, backgroundColor: colors.textSecondary, alignItems: "center", justifyContent: "center" },
  hole: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.surface },
});
