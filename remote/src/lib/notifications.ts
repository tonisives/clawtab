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
  // Categories are registered dynamically by the Notification Service Extension
  // (NotificationService.swift) per notification with real option labels.
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
