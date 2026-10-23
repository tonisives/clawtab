export let jobListState = ({ authenticated, authLoading, connected, hostOnline, loaded, error }: {
  authenticated: boolean
  authLoading: boolean
  connected: boolean
  hostOnline: boolean
  loaded: boolean
  error?: string | null
}) => {
  if (authLoading) return { demo: false, loading: "Loading your account…" }
  if (!authenticated && !connected) return { demo: true, loading: null }
  if (!connected && error === "Relay subscription required") return { demo: true, loading: null }
  if (!connected) return { demo: false, loading: "Connecting to relay…" }
  if (hostOnline && !loaded) return { demo: false, loading: "Loading jobs…" }
  return { demo: false, loading: null }
}
