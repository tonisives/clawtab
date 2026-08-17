import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";

import { colors } from "../../src/theme/colors";
import { NotificationsPanel } from "../../src/components/NotificationsPanel";
import type { NotificationDetailTarget } from "../../src/components/notificationTypes";
import { notificationJobRoute, notificationProcessRoute } from "../../src/lib/notificationRoutes";

export default function NotificationsScreen() {
  const router = useRouter();
  const handleSelectDetail = (target: NotificationDetailTarget) => {
    if (target.paneId) {
      router.push(notificationProcessRoute(target.paneId));
      return;
    }
    if (target.kind === "process") {
      router.push(notificationProcessRoute(target.paneId));
      return;
    }
    router.push(notificationJobRoute(target.jobName));
  };

  return (
    <View style={styles.root}>
      <View style={styles.panel}>
        <NotificationsPanel mode="screen" onSelectDetail={handleSelectDetail} />
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
