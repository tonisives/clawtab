import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "expo-router";
import { useResponsive } from "./useResponsive";
import { sameLandscapeShell, useLandscapeShellStore, type LandscapeShell } from "../store/landscapeShell";

export function useLandscapeShellNavigation(shell: LandscapeShell, fromSplit: boolean) {
  const router = useRouter();
  const { isIosPhoneLandscape } = useResponsive();
  const previousLandscape = useRef(isIosPhoneLandscape);

  useEffect(() => {
    if (previousLandscape.current && !fromSplit) {
      useLandscapeShellStore.getState().showFullScreen(shell);
    }
  }, []);

  useEffect(() => {
    const rotatedToLandscape = !previousLandscape.current && isIosPhoneLandscape;
    previousLandscape.current = isIosPhoneLandscape;
    if (!rotatedToLandscape) return;
    if (sameLandscapeShell(useLandscapeShellStore.getState().fullScreenShell, shell)) return;
    useLandscapeShellStore.getState().showSidebar(shell);
    if (fromSplit && router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  }, [fromSplit, isIosPhoneLandscape, router, shell.kind, shell.kind === "job" ? shell.slug : shell.paneId]);

  return useCallback(() => {
    useLandscapeShellStore.getState().showSidebar(shell);
    if (fromSplit && router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  }, [fromSplit, router, shell.kind, shell.kind === "job" ? shell.slug : shell.paneId]);
}
