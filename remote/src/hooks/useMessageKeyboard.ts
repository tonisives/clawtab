import type { ComponentRef } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Dimensions, Keyboard, Platform, type KeyboardEvent, type View, useWindowDimensions } from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";

// Measure the unchanged host, rather than subtracting the keyboard twice after
// the WebView has resized. This also works for the smaller arrival popup.
export function useMessageKeyboard() {
  const host = useRef<ComponentRef<typeof View>>(null);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [horizontalInsets, setHorizontalInsets] = useState({ left: 0, right: 0 });
  const keyboardTop = useRef<number | null>(null);
  const [overlap, setOverlap] = useState(0);
  const measure = useCallback(() => {
    const top = keyboardTop.current;
    host.current?.measureInWindow((x, y, hostWidth, height) => {
      setHorizontalInsets({ left: Math.max(0, insets.left - x), right: Math.max(0, x + hostWidth - width + insets.right) });
      if (keyboardTop.current === top) setOverlap(top === null ? 0 : Math.max(0, Math.min(height, y + height - top)));
    });
  }, [width, insets.left, insets.right]);
  useEffect(measure, [measure]);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const reset = () => { keyboardTop.current = null; setOverlap(0); };
    const change = (event: KeyboardEvent) => {
      const { screenY, height } = event.endCoordinates;
      if (height <= 0 || screenY >= Dimensions.get("screen").height) { reset(); return; }
      keyboardTop.current = screenY;
      measure();
    };
    const subscriptions = [
      Keyboard.addListener("keyboardWillChangeFrame", change),
      Keyboard.addListener("keyboardWillHide", reset),
      AppState.addEventListener("change", state => { if (state === "background" || !Keyboard.isVisible()) reset(); }),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [measure]);
  return { host, overlap, horizontalInsets, onLayout: measure };
}
