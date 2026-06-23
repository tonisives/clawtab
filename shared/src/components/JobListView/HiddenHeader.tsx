import { Text, TouchableOpacity, View } from "react-native";

import { colors } from "../../theme/colors";
import { spacing } from "../../theme/spacing";
import type { ListItem } from "./sign";
import { styles } from "./styles";
import type { JobListViewHook } from "./useJobListView";

interface JobListHiddenHeaderProps {
  hook: JobListViewHook;
  item: Extract<ListItem, { kind: "hidden-header" }>;
  itemKey: string;
}

export function JobListHiddenHeader({ hook, item, itemKey }: JobListHiddenHeaderProps) {
  return (
    <View key={itemKey} style={{ marginTop: spacing.xs }}>
      <View style={[styles.groupHeaderRow, { opacity: 0.5 }]}>
        <Text style={styles.groupHeader}>{item.displayGroup}</Text>
        <View style={{ flex: 1 }} />
        {hook.onUnhideGroup && (
          <TouchableOpacity
            onPress={() => hook.onUnhideGroup?.(item.group)}
            style={styles.addJobBtn}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={{ fontSize: 12, color: colors.textMuted }}>Show</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}
