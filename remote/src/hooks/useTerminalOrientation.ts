import { useCallback } from "react";
import { Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";

export function useTerminalOrientation(enabled = true) {
  useFocusEffect(useCallback(() => {
    if (!enabled || Platform.OS !== "ios" || Platform.isPad) return;
    void ScreenOrientation.unlockAsync().catch(() => {});
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, [enabled]));
}
