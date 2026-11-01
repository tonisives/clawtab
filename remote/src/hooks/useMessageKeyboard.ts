import type { ComponentRef } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Dimensions, Keyboard, Platform, type KeyboardEvent, type KeyboardMetrics, type View, useWindowDimensions } from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";

// Native message routes reach the bottom of the modal. Use the keyboard height
// there; a sheet's measured origin can differ from the keyboard's window origin.
// Smaller popup hosts still need their actual intersection with the keyboard.
export function useMessageKeyboard(bottomAnchored = true) {
  const host = useRef<ComponentRef<typeof View>>(null);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [horizontalInsets, setHorizontalInsets] = useState({ left: 0, right: 0 });
  const keyboardFrame = useRef<KeyboardMetrics | null>(null);
  const [overlap, setOverlap] = useState(0);
  const measure = useCallback(() => {
    const frame = keyboardFrame.current;
    host.current?.measureInWindow((x, y, hostWidth, height) => {
      setHorizontalInsets({ left: Math.max(0, insets.left - x), right: Math.max(0, x + hostWidth - width + insets.right) });
      if (keyboardFrame.current === frame) setOverlap(frame === null ? 0 : bottomAnchored ? frame.height : Math.max(0, Math.min(height, y + height - frame.screenY)));
    });
  }, [width, insets.left, insets.right, bottomAnchored]);
  useEffect(measure, [measure]);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const reset = (event?: KeyboardEvent) => {
      if (event) Keyboard.scheduleLayoutAnimation(event);
      keyboardFrame.current = null; setOverlap(0);
    };
    const apply = (frame: KeyboardMetrics) => {
      const { screenY, height } = frame;
      if (height <= 0 || screenY >= Dimensions.get("screen").height) { reset(); return; }
      keyboardFrame.current = frame;
      if (bottomAnchored) setOverlap(height);
      measure();
    };
    const change = (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      apply(event.endCoordinates);
    };
    const subscriptions = [
      Keyboard.addListener("keyboardWillShow", change),
      Keyboard.addListener("keyboardWillChangeFrame", change),
      Keyboard.addListener("keyboardDidShow", change),
      Keyboard.addListener("keyboardWillHide", reset),
      Keyboard.addListener("keyboardDidHide", reset),
      AppState.addEventListener("change", state => { if (state === "background" || !Keyboard.isVisible()) reset(); }),
    ];
    const current = Keyboard.metrics();
    if (current) apply(current);
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [measure, bottomAnchored]);
  return { host, overlap, horizontalInsets, onLayout: measure };
}
