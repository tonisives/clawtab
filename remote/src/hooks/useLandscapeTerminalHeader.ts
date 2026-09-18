import { useCallback, useEffect, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

export function useLandscapeTerminalHeader(active: boolean) {
  const { width, height } = useWindowDimensions();
  const isLandscape = Platform.OS === "ios" && !Platform.isPad && width > height;
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setRevealed(false);
  }, [isLandscape, active]);

  const onScrollGesture = useCallback((direction: "up" | "down") => {
    if (isLandscape && active) setRevealed(direction === "up");
  }, [isLandscape, active]);

  return {
    isLandscape,
    headerShown: !isLandscape || !active,
    overlayShown: isLandscape && active && revealed,
    onScrollGesture,
  };
}
