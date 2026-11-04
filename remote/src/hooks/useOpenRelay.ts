import { useCallback, useEffect, useRef } from "react"
import { useRouter } from "expo-router"
import { useAuthStore } from "../store/auth"
import { loadRelaySubscription, loadRelayWorkspace } from "../lib/relaySubscriptionCache"

export function useOpenRelay(method: "push" | "dismissTo" = "push") {
  const router = useRouter()
  const userId = useAuthStore(state => state.userId)
  const opening = useRef(false)
  const prepare = useCallback(async () => {
    if (userId) {
      const subscription = await loadRelaySubscription(userId)
      if (useAuthStore.getState().userId !== userId) return
      if (subscription.hosted_workspace_eligible) await loadRelayWorkspace(userId)
    }
  }, [userId])
  useEffect(() => { void prepare().catch(() => {}) }, [prepare])
  return useCallback(async () => {
    if (opening.current) return
    opening.current = true
    try {
      await prepare().catch(() => {})
      if (useAuthStore.getState().userId === userId) {
        router.prefetch("/workspace")
        router[method]("/workspace")
      }
    } finally { opening.current = false }
  }, [router, userId, method, prepare])
}
