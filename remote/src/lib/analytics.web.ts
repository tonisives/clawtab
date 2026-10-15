type AnalyticsWindow = Window & { gtag?: (...args: unknown[]) => void; dataLayer?: unknown[] }
type RemoteEvent = "login" | "remote_pairing_complete" | "remote_host_connected" | "remote_app_view"
const MEASUREMENT_ID = "G-01CG8GHYTS"
let initialized = false
let connectedHostTracked = false

export let analyticsAllowed = () => typeof window !== "undefined"
  && window.location.hostname === "remote.clawtab.cc"
  && navigator.doNotTrack !== "1"
  && !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl

export let safeEntryPage = (value: string) => /^\/(?:articles(?:\/[a-z0-9-]+)?|remote|mobile|tmux|docs|privacy|ios-demo|author)?$/.test(value) ? value : "/other"

let entryPage = () => {
  try {
    let cookie = document.cookie.split("; ").find((item) => item.startsWith("ct_entry="))?.slice(9)
    return cookie ? safeEntryPage(decodeURIComponent(cookie)) : "/remote"
  } catch {
    return "/remote"
  }
}

export let initializeWebAnalytics = () => {
  try {
    if (!analyticsAllowed() || initialized) return
    initialized = true
    let browser = window as AnalyticsWindow
    browser.dataLayer ??= []
    // Google's command queue requires an Arguments object.
    browser.gtag ??= function () { browser.dataLayer!.push(arguments) }
    browser.gtag("js", new Date())
    // Enhanced Measurement is disabled for this stream. Never expose app routes,
    // OAuth query strings, machine names, terminal content, or account identifiers.
    browser.gtag("config", MEASUREMENT_ID, {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      page_location: "https://remote.clawtab.cc/",
      page_referrer: "",
      page_title: "ClawTab Remote",
    })
    let script = document.createElement("script")
    script.async = true
    script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`
    document.head.appendChild(script)
    sendEvent("remote_app_view")
  } catch { /* Analytics cannot block app initialization. */ }
}

let sendEvent = (event: RemoteEvent) => {
  ;(window as AnalyticsWindow).gtag?.("event", event, {
    entry_page: entryPage(),
    source_page: "/web-remote",
    page_location: "https://remote.clawtab.cc/",
    page_referrer: "",
    page_title: "ClawTab Remote",
    transport_type: "beacon",
  })
}

export let trackRemoteEvent = (event: "login" | "remote_pairing_complete") => {
  try {
    if (!analyticsAllowed()) return
    initializeWebAnalytics()
    sendEvent(event)
  } catch { /* Analytics cannot block sign-in or pairing. */ }
}

export let trackConnectedHost = () => {
  try {
    if (!analyticsAllowed() || connectedHostTracked) return
    initializeWebAnalytics()
    connectedHostTracked = true
    let key = "clawtab_host_observed"
    try {
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, "1")
    } catch { /* In-memory deduplication still works when storage is unavailable. */ }
    // One owned online host observed per browser-tab session, not a lifetime
    // account conversion. Reconnecting an existing host does not repeat it.
    sendEvent("remote_host_connected")
  } catch { /* Analytics cannot affect the machine connection. */ }
}
