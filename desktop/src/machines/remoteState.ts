export type RelayConnection = {
  enabled: boolean
  connected: boolean
  configured: boolean
  auth_expired: boolean
  subscription_required: boolean
}

export type RemoteState = {
  account: "checking" | "ready" | "required"
  relay: RelayConnection | null
  operation: "connect" | "disconnect" | null
  signedOut: boolean
  error: string | null
}

export let remoteConnectionState = (state: RemoteState, machines: { connected: boolean; error: string | null }) => {
  if (state.operation === "disconnect") return { phase: "disconnecting", label: "Disconnecting…" }
  if (state.signedOut) return { phase: "disconnected", label: "Disconnected" }
  if (state.error) return { phase: "interrupted", label: "Connection interrupted" }
  if (state.account === "required") return { phase: "sign_in", label: "Sign in to connect" }
  if (state.account === "checking" || !state.relay) return { phase: "checking", label: "Checking connection…" }
  if (!state.relay.configured) return { phase: "setup", label: "Pair this Mac to connect" }
  if (!state.relay.enabled && state.operation !== "connect") return { phase: "disconnected", label: "Disconnected" }
  if (state.relay.subscription_required) return { phase: "subscription", label: "Subscription required" }
  if (state.operation === "connect") return { phase: "connecting", label: "Connecting…" }
  if (!machines.connected && machines.error) return { phase: "interrupted", label: "Connection interrupted" }
  if (!state.relay.connected || !machines.connected) return { phase: "connecting", label: "Connecting…" }
  return { phase: "connected", label: "Connected" }
}
