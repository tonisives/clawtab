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

  // Pre-register fallback categories for different option counts.
  // The NSE dynamically creates per-question categories with real labels,
  // but these serve as fallbacks if the NSE doesn't run.
  const textInput = {
    identifier: "TEXT_INPUT",
    buttonTitle: "Type answer...",
    textInput: { submitButtonTitle: "Send", placeholder: "Your answer" },
    options: { opensAppToForeground: false },
  };

  Notifications.setNotificationCategoryAsync("CLAUDE_Q2", [
    { identifier: "1", buttonTitle: "Option 1", options: { opensAppToForeground: false } },
    { identifier: "2", buttonTitle: "Option 2", options: { opensAppToForeground: false } },
    textInput,
  ]).catch(() => {});

  Notifications.setNotificationCategoryAsync("CLAUDE_Q3", [
    { identifier: "1", buttonTitle: "Option 1", options: { opensAppToForeground: false } },
    { identifier: "2", buttonTitle: "Option 2", options: { opensAppToForeground: false } },
    { identifier: "3", buttonTitle: "Option 3", options: { opensAppToForeground: false } },
    textInput,
  ]).catch(() => {});

  Notifications.setNotificationCategoryAsync("CLAUDE_Q4", [
    { identifier: "1", buttonTitle: "Option 1", options: { opensAppToForeground: false } },
    { identifier: "2", buttonTitle: "Option 2", options: { opensAppToForeground: false } },
    { identifier: "3", buttonTitle: "Option 3", options: { opensAppToForeground: false } },
    { identifier: "4", buttonTitle: "Option 4", options: { opensAppToForeground: false } },
    textInput,
  ]).catch(() => {});
}

/** Dismiss any delivered notifications matching the given question ID. */
export async function dismissQuestionNotification(questionId: string) {
  if (Platform.OS === "web") return;
  try {
    const delivered = await Notifications.getPresentedNotificationsAsync();
    for (const n of delivered) {
      const data = n.request.content.data as {
        clawtab?: { question_id?: string };
      } | undefined;
      if (data?.clawtab?.question_id === questionId) {
        await Notifications.dismissNotificationAsync(n.request.identifier);
      }
    }
  } catch (e) {
    console.log("[notifications] failed to dismiss:", e);
  }
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
