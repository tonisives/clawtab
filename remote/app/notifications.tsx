import { StyleSheet, View } from "react-native";

import { colors } from "../src/theme/colors";
import { NotificationsPanel } from "../src/components/NotificationsPanel";

export default function NotificationsScreen() {
  return (
    <View style={styles.root}>
      <View style={styles.panel}>
        <NotificationsPanel mode="screen" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  panel: {
    flex: 1,
    minHeight: 0,
  },
});
