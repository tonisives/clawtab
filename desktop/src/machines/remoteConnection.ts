import { useSyncExternalStore } from "react"
import { invoke } from "@tauri-apps/api/core"
import { retryMachines, useMachines } from "@clawtab/shared"
import { remoteConnectionState, type RelayConnection, type RemoteState } from "./remoteState"

type Session = RemoteState & { token: string | null; accountVersion: number }
let session: Session = { account: "checking", relay: null, operation: null, signedOut: false, error: null, token: null, accountVersion: 0 }
let listeners = new Set<() => void>()
let version = 0
let checking: Promise<void> | null = null
let suspended = false
let update = (patch: Partial<Session>) => {
  session = { ...session, ...patch }
  listeners.forEach(listener => listener())
}
let subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
let snapshot = () => session
export let useRemoteConnection = () => {
  let state = useSyncExternalStore(subscribe, snapshot, snapshot)
  let machines = useMachines()
  return { ...state, ...remoteConnectionState(state, machines) }
}

let setEnabled = async (enabled: boolean) => {
  let settings = await invoke<Record<string, unknown> | null>("get_relay_settings")
  if (settings?.server_url) await invoke("set_relay_settings", { settings: { ...settings, enabled } })
  if (session.relay) update({ relay: { ...session.relay, enabled } })
  if (!enabled) await invoke("relay_disconnect")
}

export let checkRemoteConnection = async () => {
  if (checking || session.operation || suspended) return checking
  let current = version
  checking = (async () => {
    try {
      let [relay, token] = await Promise.all([
        invoke<RelayConnection>("get_relay_status"),
        invoke<string | null>("relay_restore_account"),
      ])
      if (current !== version) return
      update({ relay, token, account: token ? "ready" : "required", error: null,
        accountVersion: token !== session.token ? session.accountVersion + 1 : session.accountVersion })
      if (!token && relay.enabled) {
        await setEnabled(false)
        let latest = await invoke<RelayConnection>("get_relay_status")
        if (current === version) update({ relay: latest })
      }
    } catch {
      if (current === version) update({ error: "Could not connect. Check your network and try again." })
    } finally {
      checking = null
    }
  })()
  return checking
}

export let connectRemoteConnection = async () => {
  if (session.operation) return
  suspended = false
  let requestedVersion = version
  await checkRemoteConnection()
  if (requestedVersion !== version || session.operation) return
  if (!session.token || !session.relay?.configured) return
  let current = ++version
  update({ operation: "connect", signedOut: false, error: null })
  try {
    await setEnabled(true)
    if (!session.relay.connected) await invoke("relay_connect")
    let relay = await invoke<RelayConnection>("get_relay_status")
    if (current !== version) return
    update({ relay })
    retryMachines()
  } catch {
    if (current === version) update({ error: "Could not connect. Please try again." })
  } finally {
    if (current === version) update({ operation: null })
  }
}

export let beginRemoteSignIn = () => {
  version++
  suspended = true
}

export let acceptRemoteSignIn = async (token: string) => {
  version++
  suspended = false
  update({ token, account: "ready", signedOut: false, error: null, accountVersion: session.accountVersion + 1 })
  await connectRemoteConnection()
}

export let disconnectRemoteConnection = async () => {
  if (session.operation) throw new Error("A connection change is already in progress.")
  let current = ++version
  suspended = true
  update({ operation: "disconnect", error: null })
  try {
    await setEnabled(false)
    await invoke("relay_sign_out")
    update({ token: null, account: "required", signedOut: true })
  } catch {
    suspended = false
    update({ error: "Could not disconnect completely. Please try again." })
    throw new Error("Could not disconnect completely. Please try again.")
  } finally {
    if (current === version) update({ operation: null })
  }
}

export let watchRemoteConnection = () => {
  let active = true
  void checkRemoteConnection()
  let focus = () => { if (!document.hidden) void checkRemoteConnection() }
  window.addEventListener("focus", focus)
  document.addEventListener("visibilitychange", focus)
  let timer = setInterval(() => {
    if (session.operation) return
    let requestVersion = version
    void invoke<RelayConnection>("get_relay_status").then(relay => {
      if (active && requestVersion === version) update({ relay })
    }).catch(() => {
      if (active && requestVersion === version) update({ relay: null })
    })
  }, 5000)
  return () => {
    active = false
    clearInterval(timer)
    window.removeEventListener("focus", focus)
    document.removeEventListener("visibilitychange", focus)
  }
}
