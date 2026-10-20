import type { useIdTokenAuthRequest } from "expo-auth-session/providers/google";

// Native sign-in uses GoogleSignin; no browser request is created during render.
export function useGoogleBrowserAuth(
  _config: Parameters<typeof useIdTokenAuthRequest>[0],
): ReturnType<typeof useIdTokenAuthRequest> {
  return [null, null, async () => {
    throw new Error("Google sign-in is unavailable in this app build.");
  }];
}
