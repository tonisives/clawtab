import { useAuthStore } from "../store/auth";
import type { BrowserGoogleRequest } from "./googleBrowserRedirect";

const pendingKey = "clawtab_google_redirect";
const maxAge = 10 * 60 * 1000;
type Pending = { state: string; destination: string; loginPath: string; startedAt: number };

export function beginGoogleBrowserRedirect(request: BrowserGoogleRequest | null, destination: string): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  if (!ios) return false;
  if (!request?.url) throw new Error("Google sign-in is still loading. Please try again.");
  const pending: Pending = { state: request.state, destination,
    loginPath: window.location.pathname + window.location.search, startedAt: Date.now() };
  window.sessionStorage.setItem(pendingKey, JSON.stringify(pending));
  window.location.assign(request.url);
  return true;
}

// This runs before the app mounts. The same tab exchanges Google's result and
// saves the session before returning to the original ClawTab destination.
export function completeGoogleBrowserRedirect(params: URLSearchParams): boolean {
  const saved = window.sessionStorage.getItem(pendingKey);
  if (!saved) return false;
  window.sessionStorage.removeItem(pendingKey);
  const pending: Pending = JSON.parse(saved);
  window.history.replaceState(null, "", window.location.pathname);
  const fail = (message: string) => {
    const login = new URL(pending.loginPath, window.location.origin);
    login.searchParams.set("auth_error", message);
    window.location.replace(login.href);
  };
  if (params.get("state") !== pending.state || Date.now() - pending.startedAt > maxAge) {
    fail("Google sign-in expired. Please try again.");
    return true;
  }
  const token = params.get("id_token");
  if (!token || params.has("error")) {
    fail(params.get("error") === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in failed. Please try again.");
    return true;
  }
  void useAuthStore.getState().googleLogin(token).then(() => {
    window.location.replace(new URL(pending.destination, window.location.origin).href);
  }).catch(() => fail("Google sign-in failed. Please try again."));
  return true;
}
