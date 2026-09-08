import { useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { connectMachines } from "@clawtab/shared"
let localMachine: string | undefined
export let localMachineId = () => localMachine
export let useDesktopMachines = () => {
  useEffect(
    () =>
      connectMachines(async () => {
        let connection = await invoke<{ url: string; machine_id?: string }>("machine_connection")
        localMachine = connection.machine_id
        return connection.url
      }),
    [],
  )
}
export let approveDesktopMachine = (code: string) => invoke("machine_pair_approve", { code })
export let localHostRequest = (request: Record<string, unknown>) =>
  invoke<Record<string, any>>("machine_local_request", { request })

export let desktopMachineApi = (method: string, path: string, body?: Record<string, unknown>) =>
  invoke<Record<string, any>>("machine_api", { method, path, body })
