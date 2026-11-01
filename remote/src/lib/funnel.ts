import { Platform } from "react-native"
import * as Crypto from "expo-crypto"
import * as storage from "./storage"
import { trackFunnelEvent } from "./analytics"
import { createFunnelTracker, FUNNEL_DISABLED_KEY, type FunnelEvent } from "../../../shared/src/funnel"

export { FUNNEL_DISABLED_KEY } from "../../../shared/src/funnel"
let enabled = async () => {
  let server = await storage.getItem("clawtab_server_url")
  if (server && server !== "https://relay.clawtab.cc") return false
  if (Platform.OS !== "web") return !__DEV__
  return window.location.hostname === "remote.clawtab.cc" && navigator.doNotTrack !== "1"
    && !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl
}

let record = createFunnelTracker(Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web", storage, Crypto.randomUUID, enabled)
export let trackFunnel = async (event: FunnelEvent) => {
  if (Platform.OS === "web") {
    try {
      if (await enabled() && await storage.getItem(FUNNEL_DISABLED_KEY) !== "1") trackFunnelEvent(event)
    } catch { /* Storage failures leave analytics disabled. */ }
  }
  await record(event)
}
