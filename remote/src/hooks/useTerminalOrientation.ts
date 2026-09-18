import { useCallback, useState } from "react";
import { Alert, Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";

export function useTerminalOrientation() {
  const [landscape, setLandscape] = useState(false);
  const [changing, setChanging] = useState(false);
  const available = Platform.OS === "ios" && !Platform.isPad;

  useFocusEffect(useCallback(() => {
    if (!available) return;
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    return () => {
      setLandscape(false);
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, [available]));

  const toggle = useCallback(async () => {
    if (!available || changing) return;
    setChanging(true);
    try {
      await ScreenOrientation.lockAsync(landscape
        ? ScreenOrientation.OrientationLock.PORTRAIT_UP
        : ScreenOrientation.OrientationLock.LANDSCAPE);
      setLandscape(!landscape);
    } catch {
      Alert.alert("Could not rotate terminal", "Please try again.");
    } finally {
      setChanging(false);
    }
  }, [available, changing, landscape]);

  return { available, landscape, toggle };
}
