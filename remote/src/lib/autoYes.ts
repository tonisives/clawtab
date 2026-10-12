import { machineRequest, machineState, onMachineEvent, splitResource } from "@clawtab/shared"
import { useNotificationStore } from "../store/notifications"
import { alertError, confirm } from "./platform"

let applyingAutoYes = new Map<string, boolean>()

let updateAutoYes = async (paneId: string, enabled: boolean, timeout: number) => {
  let resource = splitResource(paneId)
  if (!resource) throw new Error("Select a machine to continue")
  let paneIds = new Set<string>(machineState().snapshots[resource.machine]?.auto_yes_panes?.pane_ids ?? [])
  for (let [id, value] of applyingAutoYes) {
    let pending = splitResource(id)
    if (pending?.machine !== resource.machine) continue
    if (value) paneIds.add(pending.id)
    else paneIds.delete(pending.id)
  }
  let unsubscribe = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let applied = new Promise<void>((resolve, reject) => {
    unsubscribe = onMachineEvent((machine, message) => {
      if (machine !== resource.machine || message.type !== "auto_yes_panes") return
      if (message.pane_ids.includes(resource.id) === enabled) resolve()
    })
    timer = setTimeout(() => reject(new Error("Auto yes update was not confirmed by the machine. Please try again.")), timeout)
  })
  try {
    // The relay's "sent" response only confirms forwarding. Wait for host state too.
    await Promise.all([
      machineRequest(resource.machine, { type: "set_auto_yes_panes", pane_ids: [...paneIds] }, timeout),
      applied,
    ])
  } finally {
    clearTimeout(timer)
    unsubscribe()
  }
}

export let toggleAutoYes = (paneId: string, title: string, onEnabled?: () => void, timeout = 10_000) => {
  let state = useNotificationStore.getState()
  if (!paneId || state.pendingAutoYes.has(paneId)) return
  let enabled = !state.autoYesPaneIds.has(paneId)
  state.beginAutoYes(paneId, enabled)
  let cancel = () => useNotificationStore.getState().finishAutoYes(paneId, false)
  let apply = async () => {
    applyingAutoYes.set(paneId, enabled)
    try {
      await updateAutoYes(paneId, enabled, timeout)
      useNotificationStore.getState().finishAutoYes(paneId, true)
    } catch (error) {
      cancel()
      alertError("Could not update Auto yes", error instanceof Error ? error.message : "Please try again.")
      return
    } finally {
      applyingAutoYes.delete(paneId)
    }
    if (enabled) onEnabled?.()
  }
  if (!enabled) { void apply(); return }
  confirm("Enable auto-yes?", `All future questions for "${title}" will be automatically accepted with "Yes". This stays active until you disable it.`, () => { void apply() }, cancel)
}
