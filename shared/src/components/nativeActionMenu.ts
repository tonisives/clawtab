import { ActionSheetIOS, Alert, Platform } from "react-native";

export interface NativeActionMenuItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

export function showNativeActionMenu(items: NativeActionMenuItem[], title = "Actions") {
  if (Platform.OS === "web") return false;
  const actionable = items.filter((item) => item.label.trim().length > 0);
  if (actionable.length === 0) return true;

  if (Platform.OS === "ios") {
    const options = [...actionable.map((item) => item.label), "Cancel"];
    const cancelButtonIndex = options.length - 1;
    const destructiveButtonIndex = actionable.findIndex((item) => item.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex,
        destructiveButtonIndex: destructiveButtonIndex >= 0 ? destructiveButtonIndex : undefined,
        title,
      },
      (buttonIndex) => {
        if (buttonIndex === cancelButtonIndex) return;
        actionable[buttonIndex]?.onPress();
      },
    );
    return true;
  }

  Alert.alert(
    title,
    undefined,
    [
      ...actionable.map((item) => ({
        text: item.label,
        style: item.destructive ? "destructive" as const : "default" as const,
        onPress: item.onPress,
      })),
      { text: "Cancel", style: "cancel" as const },
    ],
    { cancelable: true },
  );
  return true;
}
