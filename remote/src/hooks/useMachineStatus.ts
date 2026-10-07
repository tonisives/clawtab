import { splitResource, useMachines } from "@clawtab/shared"

export let useMachineStatus = (resource: string) => {
  let state = useMachines()
  let machineId = splitResource(resource)?.machine ?? state.selected
  let machine = machineId
    ? state.machines.find((item) => item.id === machineId)
    : state.machines.find((item) => item.owned && item.online)
  return { connected: state.connected, online: machine?.online ?? false }
}
