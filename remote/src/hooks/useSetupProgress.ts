import { useMachines } from "@clawtab/shared"
import { useWsStore } from "../store/ws"

export let useSetupProgress = () => {
  let relay = useMachines()
  let connected = useWsStore((state) => state.connected)
  let desktopOnline = useWsStore((state) => state.desktopOnline)
  let machineComplete = relay.machines.length > 0 || desktopOnline
  let relayComplete = relay.connected || connected || machineComplete
  return { relayComplete, machineComplete, complete: relayComplete && machineComplete }
}
