import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { connectMachines, machineErrorMessage, saveAccountPreferences } from "@clawtab/shared"
import type { AppSettings } from "../types"
import { checkRemoteConnection, useRemoteConnection, watchRemoteConnection } from "./remoteConnection"
let machineInvoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    let message = machineErrorMessage(error)
    if (["Token refresh failed", "No access token stored", "unauthorized"].includes(message)) {
      void checkRemoteConnection()
      message = "Your ClawTab session could not be renewed. Sign in again in Remote Access."
    }
    throw new Error(message)
  }
}
let localMachine: string | undefined
export let localMachineId = () => localMachine
export let resetDesktopAccount = () => window.dispatchEvent(new Event("desktop-account-changed"))
export let useDesktopMachines = () => {
  let remote = useRemoteConnection()
  let enabled = remote.account === "ready" && !!remote.relay?.enabled && remote.relay.configured && remote.operation !== "disconnect" && !remote.signedOut
  useEffect(watchRemoteConnection, [])
  let [accountVersion, setAccountVersion] = useState(0)
  useEffect(() => {
    let reset = () => { localMachine = undefined; setAccountVersion(version => version + 1) }
    window.addEventListener("desktop-account-changed", reset)
    return () => window.removeEventListener("desktop-account-changed", reset)
  }, [])
  useEffect(() => {
    if (!enabled) return;
    let active = true
    let lastModels = ""
    let queue = Promise.resolve()
    let pending: { agent_models: ReturnType<typeof modelPreferences>; initialize: boolean } | null = null
    let flush = () => {
      queue = queue.then(async () => {
        if (!pending || !active) return
        let next = pending
        try {
          await saveAccountPreferences(desktopMachineApi, next)
          if (pending === next) pending = null
        } catch { /* Retry after connectivity returns. */ }
      })
    }
    let publish = (settings: AppSettings, initialize: boolean) => {
      let agent_models = modelPreferences(settings)
      let serialized = JSON.stringify(agent_models)
      if (serialized === lastModels) return
      lastModels = serialized
      pending = { agent_models, initialize }
      flush()
    }
    let unlisten = listen<AppSettings>("settings-updated", (event) => publish(event.payload, false))
    void invoke<AppSettings>("get_settings").then((settings) => {
      if (active && !lastModels) publish(settings, true)
    }).catch(() => {})
    let retry = setInterval(flush, 10_000)
    let stop = connectMachines(async () => {
      let connection = await machineInvoke<{ url: string; machine_id?: string }>("machine_connection")
      localMachine = connection.machine_id
      return connection.url
    }, desktopMachineApi)
    return () => { active = false; clearInterval(retry); void unlisten.then((off) => off()); stop() }
  }, [accountVersion, enabled, remote.accountVersion])
}
let modelPreferences = (settings: AppSettings) => ({
  enabled_models: settings.enabled_models ?? {},
  default_provider: settings.default_provider,
  default_model: settings.default_model ?? null,
})
export let approveDesktopMachine = (code: string) => machineInvoke("machine_pair_approve", { code })
export let localHostRequest = (request: Record<string, unknown>) =>
  invoke<Record<string, any>>("machine_local_request", { request })

export let desktopMachineApi = (method: string, path: string, body?: Record<string, unknown>) =>
  machineInvoke<Record<string, any>>("machine_api", { method, path, body })
