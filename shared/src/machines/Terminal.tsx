import { MachineActions } from "./Actions"
import { useEffect, useRef, useState } from "react"
import { View, Text, Pressable, StyleSheet } from "react-native"
import { XtermLog, type XtermLogHandle } from "../components/XtermLog"
import {
  useMachines,
  machineRequest,
  machineSend,
  onMachineEvent,
  splitResource,
  resourceKey,
  executionFor,
  type MachineMessage,
} from "./client"

export let MachineTerminalControls = ({ paneId, connectedOnly = false }: { paneId: string; connectedOnly?: boolean }) => {
  let state = useMachines()
  let resource = splitResource(paneId)
  if (!resource) return null
  let machine = state.machines.find((m) => m.id === resource.machine)
  if (connectedOnly && (!state.connected || !machine?.online)) return null
  let controlled = !!state.connectionId && state.controllers[paneId] === state.connectionId
  let take = () => machineSend(resource.machine, { type: "take_control", pane_id: resource.id })
  let release = () =>
    machineSend(resource.machine, { type: "release_control", pane_id: resource.id })
  return (
    <View style={styles.bar}>
      <Text style={styles.text}>
        {machine?.name ?? "Remote machine"} ·{" "}
        {machine?.online ? (controlled ? "You have control" : "Watching") : "Offline"}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={!machine?.online}
        onPress={controlled ? release : take}
        style={styles.button}
      >
        <Text style={styles.text}>{controlled ? "Release control" : "Take control"}</Text>
      </Pressable>
    </View>
  )
}
export let MachineTerminal = ({
  machineId,
  paneId,
  tmuxSession,
  onClose,
}: {
  machineId: string
  paneId: string
  tmuxSession: string
  onClose?: () => void
}) => {
  let terminal = useRef<XtermLogHandle>(null)
  let state = useMachines()
  let [error, setError] = useState<string | null>(null)
  let online = state.connected && state.machines.some((m) => m.id === machineId && m.online)
  let key = resourceKey(machineId, paneId)
  let execution = executionFor(machineId, paneId)
  let hostConnection = state.machines.find((machine) => machine.id === machineId)?.connection_id
  let controlled = state.controllers[key] === state.connectionId
  let send = (message: MachineMessage) => {
    void machineRequest(machineId, { ...message, pane_id: paneId }).catch((e) =>
      setError(e.message),
    )
  }
  useEffect(() => {
    if (!online) return
    let unlisten = onMachineEvent((machine, message) => {
      if (machine !== machineId || message.pane_id !== paneId) return
      if (message.type === "pty_output") terminal.current?.write(message.data)
      if (message.type === "pty_exit") setError("This execution has ended")
    })
    let dimensions = terminal.current?.dimensions() ?? { cols: 80, rows: 24 }
    terminal.current?.clear()
    void machineRequest(machineId, {
      type: "subscribe_pty",
      pane_id: paneId,
      tmux_session: tmuxSession,
      ...dimensions,
    }).catch((e) => setError(e.message))
    return () => {
      unlisten()
      machineSend(machineId, { type: "unsubscribe_pty", pane_id: paneId })
      machineSend(machineId, { type: "release_control", pane_id: paneId })
    }
  }, [machineId, paneId, tmuxSession, online, execution, hostConnection])
  useEffect(() => {
    if (controlled && online) {
      let dimensions = terminal.current?.dimensions()
      if (dimensions) machineSend(machineId, { type: "pty_resize", pane_id: paneId, ...dimensions })
    }
  }, [controlled, online, machineId, paneId])
  let onData = (data: string) => send({ type: "pty_input", data })
  let onResize = (cols: number, rows: number) => {
    if (controlled) send({ type: "pty_resize", cols, rows })
  }
  return (
    <View style={styles.terminal}>
      <MachineTerminalControls paneId={key} />
      <MachineActions machineId={machineId} paneId={paneId} controlled={controlled} />
      {onClose && (
        <Pressable accessibilityRole="button" onPress={onClose}>
          <Text style={styles.text}>Close terminal</Text>
        </Pressable>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <XtermLog
        ref={terminal}
        onData={onData}
        onResize={onResize}
        forceDarkTheme
        interactive={online && controlled}
      />
    </View>
  )
}
let styles = StyleSheet.create({
  terminal: { flex: 1, minHeight: 300 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 12,
    padding: 8,
    backgroundColor: "#24262a",
  },
  text: { color: "#e5e7eb", fontSize: 13 },
  button: { padding: 8, borderRadius: 6, backgroundColor: "#3a3e47" },
  error: { color: "#f8a7a7", padding: 8 },
})
