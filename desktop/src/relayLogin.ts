type RelayTokens = { access_token: string; refresh_token: string }

const GOOGLE_CLIENT_ID = "186596496380-dp282va1mvdhrr2q7qrlbgmn3ak2mq07.apps.googleusercontent.com"
const APPLE_WEB_CLIENT_ID = "cc.clawtab.web"

export let startRelayLogin = async (
  serverUrl: string,
  provider: "google" | "apple",
  signal: AbortSignal,
  openUrl: (url: string) => Promise<void>,
) => {
  let sessionId = crypto.randomUUID()
  let base = serverUrl.replace(/\/$/, "")
  let response = await fetch(`${base}/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
    signal,
  })
  if (!response.ok) throw new Error(`Could not start sign-in (HTTP ${response.status}). Please try again.`)
  signal.throwIfAborted()
  let state = btoa(`clawtab:${sessionId}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  let params = new URLSearchParams({
    client_id: provider === "google" ? GOOGLE_CLIENT_ID : APPLE_WEB_CLIENT_ID,
    redirect_uri: `${base}/auth/${provider}/callback`,
    state,
    ...(provider === "google"
      ? { response_type: "code", scope: "openid email profile", access_type: "offline", prompt: "consent" }
      : { response_type: "code id_token", response_mode: "form_post", scope: "name email" }),
  })
  await openUrl(`${provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://appleid.apple.com/auth/authorize"}?${params}`)
  return `${base}/auth/session/${sessionId}`
}

export let pollRelayLogin = async (url: string, signal: AbortSignal): Promise<RelayTokens | null> => {
  let response = await fetch(url, { signal, cache: "no-store" })
  if (response.status === 404) throw new Error("This sign-in attempt expired. Please start sign-in again.")
  if (!response.ok) throw new Error(`Could not check sign-in (HTTP ${response.status}). Please try again.`)
  let result = await response.json()
  signal.throwIfAborted()
  if (result.status === "pending") return null
  if (result.status !== "complete" || typeof result.access_token !== "string" || !result.access_token
    || typeof result.refresh_token !== "string" || !result.refresh_token) {
    throw new Error("The relay returned an incomplete sign-in result. Please try again.")
  }
  return { access_token: result.access_token, refresh_token: result.refresh_token }
}
