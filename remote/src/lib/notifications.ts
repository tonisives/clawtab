import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

// Configure notification handler for foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function registerNotificationCategories() {
  if (Platform.OS !== "ios") return;

  // Fallback category with generic labels. The Notification Service Extension
  // (nse/NotificationService.swift) intercepts each push and registers a
  // dynamic per-question category (CLAUDE_QUESTION_{id}) with real option
  // labels from the payload. This static category only appears if the NSE
  // fails to run (e.g. payload too large, extension killed by OS).
  Notifications.setNotificationCategoryAsync("CLAUDE_QUESTION", [
    { identifier: "1", buttonTitle: "1.", options: { opensAppToForeground: false } },
    { identifier: "2", buttonTitle: "2.", options: { opensAppToForeground: false } },
    { identifier: "3", buttonTitle: "3.", options: { opensAppToForeground: false } },
    { identifier: "4", buttonTitle: "4.", options: { opensAppToForeground: false } },
  ]).catch(() => {});
}

export async function getPushToken(): Promise<string | null> {
  if (Platform.OS === "web") return null;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    console.log("[notifications] permission not granted");
    return null;
  }

  try {
    const token = await Notifications.getDevicePushTokenAsync();
    return token.data;
  } catch (e) {
    console.log("[notifications] failed to get push token:", e);
    return null;
  }
}
