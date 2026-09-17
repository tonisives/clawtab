import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { AppState, Dimensions, Keyboard, Platform, type KeyboardEvent, type LayoutChangeEvent, type View } from "react-native";
import type { XtermLogHandle } from "@clawtab/shared";

type UseTerminalKeyboardOptions = {
  termRef: RefObject<XtermLogHandle | null>;
  menuOpen: boolean;
  toolbarHeight: number;
  extraClearance: number;
  overlayHeight?: number;
};

export let useTerminalKeyboard = ({
  termRef,
  menuOpen,
  toolbarHeight,
  extraClearance,
  overlayHeight = 0,
}: UseTerminalKeyboardOptions) => {
  let [keyboardVisible, setKeyboardVisible] = useState(false);
  let [keyboardHeight, setKeyboardHeight] = useState(0);
  let terminalSurfaceRef = useRef<View | null>(null);
  let keyboardTopRef = useRef<number | null>(null);
  let menuOpenRef = useRef(menuOpen);

  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  let applyKeyboardOffset = useCallback(() => {
    let keyboardTop = keyboardTopRef.current;
    if (keyboardTop === null) {
      termRef.current?.setVisualOffset(overlayHeight);
      return;
    }

    terminalSurfaceRef.current?.measureInWindow((_x, surfaceTop, _width, surfaceHeight) => {
      if (keyboardTopRef.current !== keyboardTop) return;
      let surfaceBottom = surfaceTop + surfaceHeight;
      let visibleBottom = keyboardTop - toolbarHeight - extraClearance;
      termRef.current?.setVisualOffset(Math.max(overlayHeight, surfaceBottom - visibleBottom));
    });
  }, [extraClearance, overlayHeight, termRef, toolbarHeight]);

  let resetKeyboard = useCallback(() => {
    keyboardTopRef.current = null;
    setKeyboardVisible(false);
    setKeyboardHeight(0);
    termRef.current?.setVisualOffset(overlayHeight);
  }, [overlayHeight, termRef]);

  useEffect(() => {
    requestAnimationFrame(applyKeyboardOffset);
  }, [applyKeyboardOffset]);

  let handleKeyboardFrame = useCallback((event: KeyboardEvent) => {
    let nextKeyboardHeight = event.endCoordinates?.height ?? 0;
    if (nextKeyboardHeight <= 0 || event.endCoordinates.screenY >= Dimensions.get("screen").height) {
      resetKeyboard();
      return;
    }
    let screenY = event.endCoordinates?.screenY;
    let nextKeyboardTop = Number.isFinite(screenY)
      ? screenY
      : Dimensions.get("screen").height - nextKeyboardHeight;

    keyboardTopRef.current = nextKeyboardTop;
    setKeyboardVisible(true);
    setKeyboardHeight(nextKeyboardHeight);
    requestAnimationFrame(applyKeyboardOffset);
  }, [applyKeyboardOffset, resetKeyboard]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;

    let show = Keyboard.addListener("keyboardWillShow", handleKeyboardFrame);
    let changeFrame = Keyboard.addListener("keyboardWillChangeFrame", handleKeyboardFrame);
    let hide = Keyboard.addListener("keyboardWillHide", () => {
      resetKeyboard();
      if (menuOpenRef.current) {
        setTimeout(() => termRef.current?.focus(), 0);
        return;
      }
    });

    let appState = AppState.addEventListener("change", (next) => {
      if (next === "background" || next === "active" && !Keyboard.isVisible()) resetKeyboard();
    });

    return () => {
      appState.remove();
      show.remove();
      changeFrame.remove();
      hide.remove();
    };
  }, [handleKeyboardFrame, resetKeyboard, termRef]);

  let handleTerminalLayout = useCallback((_event: LayoutChangeEvent) => {
    if (keyboardTopRef.current === null) return;
    requestAnimationFrame(applyKeyboardOffset);
  }, [applyKeyboardOffset]);

  return {
    keyboardVisible,
    keyboardHeight,
    terminalSurfaceRef,
    handleTerminalLayout,
  };
};
