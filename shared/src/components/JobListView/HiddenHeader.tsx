import { Platform, Text, TouchableOpacity, View } from "react-native";

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
    <View
      key={itemKey}
      style={[
        { marginTop: spacing.xs },
        Platform.OS !== "web" ? styles.nativeGroupHeaderWrap : null,
      ]}
    >
      <View style={styles.groupHeaderRow}>
        <View style={styles.groupHeaderTitleArea}>
          <Text style={styles.groupHeader} numberOfLines={1}>{item.displayGroup}</Text>
        </View>
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
