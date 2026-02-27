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

  // Pre-register categories for different option counts.
  // The relay sets the category based on option count (max 4).
  // Button numbers match the option numbers shown in the notification body.
  // The NSE attempts to upgrade these with real labels per notification.
  Notifications.setNotificationCategoryAsync("CLAUDE_Q2", [
    { identifier: "1", buttonTitle: "1", options: { opensAppToForeground: false } },
    { identifier: "2", buttonTitle: "2", options: { opensAppToForeground: false } },
  ]).catch(() => {});

  Notifications.setNotificationCategoryAsync("CLAUDE_Q3", [
    { identifier: "1", buttonTitle: "1", options: { opensAppToForeground: false } },
    { identifier: "2", buttonTitle: "2", options: { opensAppToForeground: false } },
    { identifier: "3", buttonTitle: "3", options: { opensAppToForeground: false } },
  ]).catch(() => {});

  Notifications.setNotificationCategoryAsync("CLAUDE_Q4", [
    { identifier: "1", buttonTitle: "1", options: { opensAppToForeground: false } },
    { identifier: "2", buttonTitle: "2", options: { opensAppToForeground: false } },
    { identifier: "3", buttonTitle: "3", options: { opensAppToForeground: false } },
    { identifier: "4", buttonTitle: "4", options: { opensAppToForeground: false } },
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
