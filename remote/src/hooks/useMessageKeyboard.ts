import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Dimensions, Keyboard, Platform, type KeyboardEvent, type View } from "react-native";

// Measure the unchanged host, rather than subtracting the keyboard twice after
// the WebView has resized. This also works for the smaller arrival popup.
export function useMessageKeyboard() {
  const host = useRef<View>(null);
  const keyboardTop = useRef<number | null>(null);
  const [overlap, setOverlap] = useState(0);
  const measure = useCallback(() => {
    const top = keyboardTop.current;
    if (top === null) { setOverlap(0); return; }
    host.current?.measureInWindow((_x, y, _width, height) => {
      if (keyboardTop.current === top) setOverlap(Math.max(0, Math.min(height, y + height - top)));
    });
  }, []);
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
  return { host, overlap, onLayout: measure };
}
