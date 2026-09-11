import { TerminalKeyBar } from "./TerminalKeyBar"
import { encodeTerminalInput } from "../util/terminalInput"
import { MachineActions } from "./Actions"
import { useEffect, useRef, useState } from "react"
import { View, Text, Pressable, StyleSheet, Modal, SafeAreaView, KeyboardAvoidingView, Platform } from "react-native"
import { XtermLog, type XtermLogHandle } from "../components/XtermLog"
import { colors } from "../theme/colors"
import { spacing } from "../theme/spacing"
import { MachineIcon, machineAppearance } from "./Appearance"
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
  let [showControlInfo, setShowControlInfo] = useState(false)
  let resource = splitResource(paneId)
  if (!resource) return null
  let machine = state.machines.find((m) => m.id === resource.machine)
  if (connectedOnly && (!state.connected || !machine?.online)) return null
  let controlled = !!state.connectionId && state.controllers[paneId] === state.connectionId
  let take = () => machineSend(resource.machine, { type: "take_control", pane_id: resource.id })
  let release = () =>
    machineSend(resource.machine, { type: "release_control", pane_id: resource.id })
  return (
    <View style={styles.controlSection}>
      <View style={styles.bar}>
        <MachineIcon appearance={machineAppearance(machine, state.machineAppearance, state.machines)} />
        <View style={styles.controlInfo}>
          <Text style={styles.machineName}>{machine?.name ?? "Remote machine"}</Text>
          <Text style={styles.controlStatus}>
            {machine?.online ? (controlled ? "You have control" : "Watching") : "Offline"}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !machine?.online }}
          disabled={!machine?.online}
          onPress={controlled ? release : take}
          style={[styles.button, !machine?.online && styles.disabledButton]}
        >
          <Text style={styles.buttonText}>{controlled ? "Release control" : "Take control"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="About terminal control"
          aria-expanded={showControlInfo}
          onPress={() => setShowControlInfo((visible) => !visible)}
          hitSlop={6}
          style={styles.infoButton}
        >
          <View style={styles.infoIcon}><Text style={styles.infoIconText}>i</Text></View>
        </Pressable>
      </View>
      {showControlInfo && (
        <Text style={styles.controlHelp}>
          Release control switches this device to Watching. The agent keeps running and you can still watch its output. Select Take control to send terminal input or resize it again. Only one connected device controls the terminal at a time.
        </Text>
      )}
    </View>
  )
}
export let MachineTerminal = ({
  machineId,
  paneId,
  tmuxSession,
  onClose,
  showActions = true,
}: {
  machineId: string
  paneId: string
  tmuxSession: string
  onClose?: () => void
  showActions?: boolean
}) => {
  let terminal = useRef<XtermLogHandle>(null)
  let state = useMachines()
  let [error, setError] = useState<string | null>(null)
  let online = state.connected && state.machines.some((m) => m.id === machineId && m.online)
  let key = resourceKey(machineId, paneId)
  let execution = executionFor(machineId, paneId)
  let hostConnection = state.machines.find((machine) => machine.id === machineId)?.connection_id
  let controlled = !!state.connectionId && state.controllers[key] === state.connectionId
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
  let onData = (data: string) => {
    if (online && controlled) send({ type: "pty_input", data })
  }
  let sendKey = (value: string) => onData(encodeTerminalInput(value))
  let onResize = (cols: number, rows: number) => {
    if (controlled) send({ type: "pty_resize", cols, rows })
  }
  return (
    <View style={styles.terminal}>
      <MachineTerminalControls paneId={key} />
      {showActions && <MachineActions machineId={machineId} paneId={paneId} controlled={controlled} />}
      {onClose && (
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}>
          <Text style={styles.text}>Close terminal</Text>
        </Pressable>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <TerminalKeyBar disabled={!online || !controlled} onKey={sendKey} />
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
export let MachineTerminalScreen = ({ machineId, paneId, tmuxSession, title, signIn = false, onClose }: {
  machineId: string
  paneId: string
  tmuxSession: string
  title: string
  signIn?: boolean
  onClose: () => void
}) => (
  <Modal visible presentationStyle="fullScreen" animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <Text numberOfLines={1} style={styles.title}>{title}</Text>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.closeButton}>
            <Text style={styles.buttonText}>Done</Text>
          </Pressable>
        </View>
        <View style={styles.terminalBody}>
          <MachineTerminal machineId={machineId} paneId={paneId} tmuxSession={tmuxSession} showActions={!signIn} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>
)

let styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 12 },
  title: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "600" },
  closeButton: { minHeight: 44, paddingHorizontal: 20, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: colors.groupedSurface, borderWidth: 1, borderColor: colors.border },
  terminalBody: { flex: 1, minHeight: 0, paddingHorizontal: 8 },
  terminal: { flex: 1, minHeight: 0 },
  controlSection: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: spacing.sm,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  controlInfo: {
    flex: 1,
    minWidth: 0,
  },
  infoButton: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  infoIcon: {
    width: 16,
    height: 16,
    borderWidth: 1,
    borderColor: colors.textMuted,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  infoIconText: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 13,
    fontWeight: "600",
  },
  controlHelp: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    paddingTop: spacing.sm,
  },
  machineName: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  controlStatus: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  text: { color: "#e5e7eb", fontSize: 13 },
  button: {
    minHeight: 30,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: 999,
    backgroundColor: colors.groupedSurface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonText: { color: colors.text, fontSize: 11 },
  disabledButton: { opacity: 0.4 },
  error: { color: "#f8a7a7", padding: 8 },
})
