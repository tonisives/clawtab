import { useCallback } from "react";
import { useRouter } from "expo-router";

export function useDetailBack(fallback = "/") {
  const router = useRouter();

  return useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(fallback);
    }
  }, [fallback, router]);
}
