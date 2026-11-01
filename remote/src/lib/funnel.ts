import { Platform } from "react-native"
import * as Crypto from "expo-crypto"
import * as storage from "./storage"
import { createFunnelTracker } from "../../../shared/src/funnel"

export { FUNNEL_DISABLED_KEY } from "../../../shared/src/funnel"
export let trackFunnel = createFunnelTracker(Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web", storage, Crypto.randomUUID, async () => {
  let server = await storage.getItem("clawtab_server_url")
  if (server && server !== "https://relay.clawtab.cc") return false
  if (Platform.OS !== "web") return !__DEV__
  return window.location.hostname === "remote.clawtab.cc" && navigator.doNotTrack !== "1"
    && !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl
})
