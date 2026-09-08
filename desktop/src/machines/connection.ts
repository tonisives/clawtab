import { useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { connectMachines, machineErrorMessage } from "@clawtab/shared"
let machineInvoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    let message = machineErrorMessage(error)
    if (["Token refresh failed", "No access token stored"].includes(message))
      message = "Your ClawTab account session could not be renewed. Sign in again in Settings → Remote to load machines."
    throw new Error(message)
  }
}
let localMachine: string | undefined
export let localMachineId = () => localMachine
export let useDesktopMachines = () => {
  useEffect(
    () =>
      connectMachines(async () => {
        let connection = await machineInvoke<{ url: string; machine_id?: string }>("machine_connection")
        localMachine = connection.machine_id
        return connection.url
      }),
    [],
  )
}
export let approveDesktopMachine = (code: string) => machineInvoke("machine_pair_approve", { code })
export let localHostRequest = (request: Record<string, unknown>) =>
  invoke<Record<string, any>>("machine_local_request", { request })

export let desktopMachineApi = (method: string, path: string, body?: Record<string, unknown>) =>
  machineInvoke<Record<string, any>>("machine_api", { method, path, body })
