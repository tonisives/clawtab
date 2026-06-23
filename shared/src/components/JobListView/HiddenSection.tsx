import { Text, TouchableOpacity } from "react-native";

import { colors } from "../../theme/colors";
import { spacing } from "../../theme/spacing";
import { styles } from "./styles";
import type { JobListViewHook } from "./useJobListView";

interface JobListHiddenSectionProps {
  hook: JobListViewHook;
  itemKey: string;
}

export function JobListHiddenSection({ hook, itemKey }: JobListHiddenSectionProps) {
  return (
    <TouchableOpacity
      key={itemKey}
      onPress={() => hook.setHiddenSectionCollapsed((value) => !value)}
      activeOpacity={0.7}
      style={{ marginTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, flexDirection: "row", alignItems: "center" }}
    >
      <Text style={[styles.groupHeader, { fontSize: 11, color: colors.textMuted, flex: 1 }]}>Hidden Groups</Text>
      <Text style={{ fontSize: 11, color: colors.textMuted, marginRight: spacing.xs }}>{hook.hiddenSectionCollapsed ? "\u25B6" : "\u25BC"}</Text>
    </TouchableOpacity>
  );
}
