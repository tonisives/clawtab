import { useEffect, useSyncExternalStore } from "react"
import { AppState, Platform } from "react-native"
import { reconnectMachines } from "@clawtab/shared"
import { useAuthStore } from "../store/auth"
import * as api from "../api/client"
import { createIapClient, type IapResult, type IapState } from "../lib/iapClient"

let client: ReturnType<typeof createIapClient> | null = null
let getClient = () => {
  if (!client) client = createIapClient({
    loadStore: () => require("react-native-iap"),
    verify: (signed_transaction, userId) => api.verifyIapReceipt({ signed_transaction }, userId),
    onVerified: (userId) => { if (useAuthStore.getState().userId === userId) reconnectMachines() },
    isActive: () => AppState.currentState === "active",
    onActive: (callback) => {
      let listener = AppState.addEventListener("change", (state) => callback(state === "active"))
      return () => listener.remove()
    },
  })
  return client
}
let unavailable: IapState = { available: false, price: null, loading: false, purchasing: false, error: null, diagnostic: null, activation: 0 }
let getUnavailable = () => unavailable
let subscribeUnavailable = () => () => undefined

// StoreKit listeners live at the app root, across navigation and sign-in.
export let useIapRecovery = () => {
  let userId = useAuthStore((state) => state.userId)
  useEffect(() => {
    if (Platform.OS !== "ios") return
    let store = getClient()
    store.setAccount(userId)
    void store.retry()
  }, [userId])
}
export let useIap = () => {
  let store = Platform.OS === "ios" ? getClient() : null
  let state = useSyncExternalStore(store?.subscribe ?? subscribeUnavailable, store?.getState ?? getUnavailable, getUnavailable)
  return {
    ...state,
    retry: () => store?.retry(),
    purchase: () => store?.purchase() ?? Promise.resolve<IapResult>({ status: "failed" }),
    restore: () => store?.restore() ?? Promise.resolve<IapResult>({ status: "failed" }),
  }
}
