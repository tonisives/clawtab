import { Alert, Platform } from "react-native";

export function confirm(
  title: string,
  message: string,
  onConfirm: () => void,
) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
  } else {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Confirm", style: "destructive", onPress: onConfirm },
    ]);
  }
}

export function alertError(title: string, message: string) {
  if (Platform.OS === "web") {
    window.alert(`${title}: ${message}`);
  } else {
    Alert.alert(title, message);
  }
}

export async function openUrl(url: string) {
  if (Platform.OS === "web") {
    window.open(url, "_blank");
  } else {
    const WebBrowser = await import("expo-web-browser");
    await WebBrowser.openBrowserAsync(url);
  }
}
