import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { ShellPane } from "../types/process";
import { shortenPath } from "../util/format";
import { colors } from "../theme/colors";
import { radius, spacing } from "../theme/spacing";
import { JobKindIcon } from "./JobKindIcon";

export function ShellCard({
  shell,
  onPress,
  selected,
  onStop,
}: {
  shell: ShellPane;
  onPress?: () => void;
  selected?: boolean | string;
  onStop?: () => void;
}) {
  return (
    <View style={[styles.card, selected && { borderColor: typeof selected === "string" ? selected : colors.accent, borderWidth: 2, opacity: 1 }]}>
      <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
        <JobKindIcon kind="shell" />
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {shortenPath(shell.cwd)}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            Shell pane
          </Text>
        </View>
        {onStop ? (
          <TouchableOpacity onPress={(e: any) => { e.stopPropagation?.(); onStop(); }} style={styles.stopBtn} activeOpacity={0.6}>
            <Text style={styles.stopBtnText}>{"\u00D7"}</Text>
          </TouchableOpacity>
        ) : null}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    opacity: 0.7,
  },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  info: { flex: 1, gap: 2, minWidth: 0 },
  name: { color: colors.text, fontSize: 13, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 11 },
  stopBtn: {
    width: 20,
    height: 20,
    justifyContent: "center",
    alignItems: "center",
    marginRight: -4,
  },
  stopBtnText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 14,
  },
});
