import { maybeCompleteAuthSession } from "expo-web-browser";

// Google returns to the root URL. Complete the popup before mounting routes or
// playing the startup animation, even when the login route was never loaded.
export function completeBrowserAuth(): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.hash.slice(1));
  for (const [key, value] of url.searchParams) params.set(key, value);
  if (!params.has("state") || !(params.has("id_token") || params.has("error"))) return false;
  return maybeCompleteAuthSession().type === "success";
}
