export type FunnelEvent = "setup_started" | "host_connected" | "terminal_viewed" | "agent_answer_sent" | "app_open" | "upgrade_view" | "checkout_attempt" | "checkout_opened" | "purchase_confirmed"
export type FunnelPlatform = "ios" | "android" | "web" | "desktop"
export const FUNNEL_DISABLED_KEY = "clawtab_analytics_disabled"

type Store = { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<void> }

export let createFunnelTracker = (platform: FunnelPlatform, store: Store, uuid: () => string, enabled: () => boolean | Promise<boolean>) => {
  let sessionId: string | undefined
  let sent = new Set<FunnelEvent>()
  let pending = Promise.resolve()
  let record = async (event: FunnelEvent) => {
    try {
      if (!await enabled() || await store.getItem(FUNNEL_DISABLED_KEY) === "1" || sent.has(event)) return
      let installationId = await store.getItem("clawtab_analytics_installation")
      if (!installationId) {
        installationId = uuid()
        await store.setItem("clawtab_analytics_installation", installationId)
      }
      sessionId ??= uuid()
      sent.add(event)
      let controller = new AbortController()
      let timeout = setTimeout(() => controller.abort(), 5000)
      try {
        let response = await fetch("https://backend.clawtab.cc/analytics/funnel", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ installation_id: installationId, session_id: sessionId, event, platform }),
          signal: controller.signal,
        })
        if (!response.ok) sent.delete(event)
      } finally { clearTimeout(timeout) }
    } catch { sent.delete(event) }
  }
  return (event: FunnelEvent) => { pending = pending.then(() => record(event)); return pending }
}
