import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";

export interface AutoYesEntry {
  paneId: string;
  label: string;
}

export interface AutoYesBannerProps {
  entries: AutoYesEntry[];
  onDisable: (paneId: string) => void;
}

export function AutoYesBanner({ entries, onDisable }: AutoYesBannerProps) {
  if (entries.length === 0) return null;

  return (
    <View style={styles.container}>
      {entries.map((e) => (
        <View key={e.paneId} style={styles.row}>
          <Text style={styles.label}>! Auto-yes: {e.label}</Text>
          <TouchableOpacity
            style={styles.disableBtn}
            onPress={() => onDisable(e.paneId)}
            activeOpacity={0.6}
          >
            <Text style={styles.disableBtnText}>Disable</Text>
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 4,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.warningBg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warning,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  label: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
  },
  disableBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  disableBtnText: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: "500",
  },
});
