import { useGlobalSearchParams, usePathname } from "expo-router"
import { useMachines } from "@clawtab/shared"
import { useAuthStore } from "../store/auth"
import { useWsStore } from "../store/ws"
import { jobListState } from "../lib/jobListState"

export function useDemoMode() {
  const pathname = usePathname()
  const params = useGlobalSearchParams<{ demo?: string }>()
  const authenticated = useAuthStore(state => state.isAuthenticated)
  const authLoading = useAuthStore(state => state.loading)
  const connected = useWsStore(state => state.connected)
  const machines = useMachines()
  return /^\/demo(?:-|\/|$)/.test(pathname) || params.demo === "1" || jobListState({
    authenticated, authLoading, connected: connected || machines.connected,
    error: machines.error, hostOnline: false, loaded: true,
  }).demo
}
