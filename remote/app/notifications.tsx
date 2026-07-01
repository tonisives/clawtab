import { StyleSheet, View } from "react-native";

import { colors } from "../src/theme/colors";
import { NotificationsPanel } from "../src/components/NotificationsPanel";

export default function NotificationsScreen() {
  return (
    <View style={styles.root}>
      <NotificationsPanel mode="screen" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
