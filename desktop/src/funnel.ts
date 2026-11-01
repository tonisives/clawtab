import { createFunnelTracker } from "../../shared/src/funnel"

export let trackFunnel = createFunnelTracker("desktop", {
  getItem: async (key) => localStorage.getItem(key),
  setItem: async (key, value) => localStorage.setItem(key, value),
}, () => crypto.randomUUID(), () => !import.meta.env.DEV)
