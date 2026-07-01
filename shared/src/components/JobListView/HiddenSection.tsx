import { Platform, Text, TouchableOpacity, View } from "react-native";

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
      style={styles.hiddenSection}
    >
      <View style={Platform.OS !== "web" ? styles.nativeGroupHeaderWrap : null}>
        <View style={styles.groupHeaderRow}>
          <View style={styles.groupHeaderTitleArea}>
            <View style={styles.groupHeaderArrowBtn}>
              <Text style={styles.groupHeaderArrow}>
                {hook.hiddenSectionCollapsed ? "\u25B6" : "\u25BC"}
              </Text>
            </View>
            <Text style={styles.groupHeader} numberOfLines={1}>Hidden Groups</Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}
