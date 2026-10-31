import { useCallback } from "react";
import { useRouter } from "expo-router";
import { useLandscapeShellStore, type LandscapeShell } from "../store/landscapeShell";

export function useLandscapeShellNavigation(shell: LandscapeShell, fromSplit: boolean) {
  const router = useRouter();
  // Resizing keeps the current route and terminal mounted. Returning to the
  // workspace is explicit, including for notification deep links.
  return useCallback(() => {
    useLandscapeShellStore.getState().showSidebar(shell);
    if (fromSplit && router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  }, [fromSplit, router, shell.kind, shell.kind === "job" ? shell.slug : shell.paneId]);
}
