import { Platform, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

type QueryLabelProps = {
  shortLabel: "q" | "l";
  fullLabel: "Query" | "Latest";
};

export function QueryLabel({ shortLabel, fullLabel }: QueryLabelProps) {
  return (
    <View style={styles.container}>
      <Text
        style={styles.label}
        accessibilityLabel={fullLabel}
        {...(Platform.OS === "web" ? { title: fullLabel } as any : {})}
      >
        {shortLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 12,
    flexShrink: 0,
  },
  label: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
  },
});
