import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";

import { colors } from "../src/theme/colors";
import { NotificationsPanel } from "../src/components/NotificationsPanel";
import type { NotificationDetailTarget } from "../src/components/notificationTypes";
import { jobRoute, processRoute } from "../src/lib/notificationRoutes";

export default function NotificationsScreen() {
  const router = useRouter();
  const handleSelectDetail = (target: NotificationDetailTarget) => {
    if (target.paneId) {
      router.push(processRoute(target.paneId, { preserveTerminal: true }));
      return;
    }
    if (target.kind === "process") {
      router.push(processRoute(target.paneId, { preserveTerminal: true }));
      return;
    }
    router.push(jobRoute(target.jobName));
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
