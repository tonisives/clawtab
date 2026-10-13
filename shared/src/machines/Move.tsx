import { useEffect, useRef, useState } from "react"
import { StyleSheet, Text, TextInput, View } from "react-native"
import { AddMachineButton, MachineActionButton, MachineModal, useMachineNavigation } from "./Onboarding"
import { machineErrorMessage, machineRequest, secureHostRequest, selectMachine, splitResource, useMachines, type MachineMessage } from "./client"
import { machineSecurity, type ClientIdentityDisplay, type MachineIdentity } from "./Security"
import { MachineTerminalScreen } from "./Terminal"
import { colors } from "../theme/colors"

type MoveLocal = { machineId: () => string | undefined; request: (request: MachineMessage) => Promise<MachineMessage> }
type Destination = { machine: string; pane: string; tmuxSession: string }
let local: MoveLocal | null = null
let navigate: ((destination: Destination) => void) | null = null
export let configureMoveLocal = (value: MoveLocal) => { local = value }
export let configureMoveNavigation = (value: (destination: Destination) => void) => { navigate = value }
let terminalStates = new Set(["completed", "failed", "cancelled"])
let irreversibleStates = new Set(["activating", "verifying", "retiring", "stopping_setup", "needs_recovery", "completed"])
let monitors = new Map<string, ReturnType<typeof setInterval>>()
// A stopped source pane can unmount its detail screen. Keep accepted handoffs
// observable independently of the component that started them.
let monitor = (operationId: string, request: MoveLocal["request"]) => {
  if (!navigate || monitors.has(operationId)) return
  let loading = false
  let seen = false
  let started = Date.now()
  let poll = async () => {
    if (loading) return
    loading = true
    try {
      let operation = await request({ action: "move_status", operation_id: operationId })
      seen = true
      if (terminalStates.has(operation.state)) {
        clearInterval(monitors.get(operationId)); monitors.delete(operationId)
        if (operation.state === "completed" && operation.remote?.pane_id) {
          selectMachine(operation.target)
          try { await machineRequest(operation.target, { type: "detect_processes" }) } catch { /* Refresh on reconnect. */ }
          navigate?.({ machine: operation.target, pane: operation.remote.pane_id, tmuxSession: operation.remote.tmux_session })
        }
      }
    } catch {
      // A rejected start may never create a record. Accepted moves remain observable
      // through a reconnect, including a source screen that has already unmounted.
      if (!seen && Date.now() - started > 20 * 60_000) { clearInterval(monitors.get(operationId)); monitors.delete(operationId) }
    }
    finally { loading = false }
  }
  monitors.set(operationId, setInterval(poll, 2000))
  void poll()
}

let MachineIdentityInput = ({ machineId, label, onVerified }: { machineId: string; label: string; onVerified: () => void }) => {
  let [value, setValue] = useState("")
  let [error, setError] = useState<string | null>(null)
  let [verified, setVerified] = useState(false)
  let verify = async () => {
    try {
      let parsed = JSON.parse(value)
      let supplied = parsed.identity ?? parsed
      let identity: MachineIdentity = { machine_id: supplied.machine_id, noise_key: supplied.noise_key, box_key: supplied.box_key }
      if (identity.machine_id !== machineId || typeof identity.noise_key !== "string" || typeof identity.box_key !== "string") throw new Error("The identity must belong to this machine")
      await machineSecurity().pin(identity)
      setError(null); setVerified(true); onVerified()
    } catch (error) { setError(machineErrorMessage(error)) }
  }
  return <View style={styles.section}>
    <Text style={styles.title}>{label}</Text>
    <Text style={styles.hint}>Run cwtctl move identity through this machine's local console or trusted SSH connection. Paste its public identity here after checking the machine ID and fingerprint.</Text>
    <TextInput accessibilityLabel={`${label} public identity`} multiline autoCapitalize="none" autoCorrect={false} value={value} onChangeText={setValue} style={styles.input} placeholder="Public machine identity JSON" placeholderTextColor={colors.textMuted} />
    <MachineActionButton label={verified ? "Identity verified" : "Verify machine identity"} disabled={!value.trim()} onPress={verify} />
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </View>
}

export let MovePanel = ({ paneId, onClose }: { paneId: string; onClose: () => void }) => {
  let machines = useMachines()
  let resource = splitResource(paneId)
  let sourceMachine = resource?.machine ?? local?.machineId()
  let sourcePane = resource?.id ?? paneId
  let sourceName = machines.machines.find((machine) => machine.id === sourceMachine)?.name ?? "This machine"
  let targets = machines.machines.filter((machine) => machine.owned && machine.id !== sourceMachine)
  let [target, setTarget] = useState<string | null>(null)
  let [destination, setDestination] = useState("~/workspace")
  let [source, setSource] = useState<MachineMessage | null>(null)
  let [preview, setPreview] = useState<MachineMessage | null>(null)
  let [operation, setOperation] = useState<MachineMessage | null>(null)
  let [identity, setIdentity] = useState<ClientIdentityDisplay | null>(null)
  let [known, setKnown] = useState<Record<string, MachineIdentity>>({})
  let [error, setError] = useState<string | null>(null)
  let [busy, setBusy] = useState(false)
  let [setupConfirmed, setSetupConfirmed] = useState(false)
  let [showSecurity, setShowSecurity] = useState(false)
  let [terminal, setTerminal] = useState<Destination | null>(null)
  let [rollbackConfirmed, setRollbackConfirmed] = useState(false)
  let observedActive = useRef(false)
  let mounted = useRef(true)
  let revision = useRef(0)
  let targetMachine = machines.machines.find((machine) => machine.id === target)
  let request = (value: MachineMessage) => {
    if (local && (!resource || resource.machine === local.machineId())) return local.request(value)
    if (!sourceMachine) return Promise.reject(new Error("Connect this machine to your account first"))
    return secureHostRequest(sourceMachine, value)
  }
  let refreshTrust = () => { void machineSecurity().machines().then((keys) => { if (mounted.current) setKnown(keys) }).catch((error) => { if (mounted.current) setError(machineErrorMessage(error)) }) }
  useEffect(() => {
    mounted.current = true
    void machineSecurity().publicIdentity().then((value) => { if (mounted.current) setIdentity(value) }).catch((error) => { if (mounted.current) setError(machineErrorMessage(error)) })
    refreshTrust()
    return () => { mounted.current = false; revision.current++ }
  }, [])
  useEffect(() => {
    if (!sourceMachine && !local) return
    let active = true
    let loading = false
    let poll = async () => {
      if (loading) return
      loading = true
      try {
        let status = await request({ action: "move_status", pane_id: sourcePane })
        if (!active) return
        let current = status.moves?.[0]
        if (current) { setOperation(current); if (!terminalStates.has(current.state)) observedActive.current = true }
      } catch { /* Readiness and explicit commands show actionable errors. */ }
      finally { loading = false }
    }
    void poll()
    let timer = setInterval(poll, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [sourceMachine, sourcePane])
  let openDestination = async (value: Destination) => {
    selectMachine(value.machine)
    if (navigate) {
      try { await machineRequest(value.machine, { type: "detect_processes" }) } catch { /* The destination screen can refresh again after reconnect. */ }
      navigate(value); onClose()
    } else setTerminal(value)
  }
  useEffect(() => {
    if (operation?.state !== "completed" || !operation.remote?.pane_id || !observedActive.current) return
    observedActive.current = false
    if (navigate) { onClose(); return }
    void openDestination({ machine: operation.target, pane: operation.remote.pane_id, tmuxSession: operation.remote.tmux_session })
  }, [operation?.state, operation?.operation_id])
  let checkReadiness = async () => {
    if (!target) return
    let generation = ++revision.current
    setBusy(true); setError(null); setPreview(null); setSetupConfirmed(false)
    try {
      let current = await request({ action: "move_source", pane_id: sourcePane })
      let path = destination === "~/workspace" ? `~/workspace/${current.cwd?.split("/").filter(Boolean).at(-1) ?? "my-project"}` : destination
      let result = await request({ action: "move_preflight", pane_id: sourcePane, execution_id: current.execution_id, target, destination: path })
      if (!mounted.current || generation !== revision.current) return
      setDestination(path); setSource(current); setPreview(result)
    } catch (error) { if (mounted.current && generation === revision.current) setError(machineErrorMessage(error)) }
    finally { if (mounted.current && generation === revision.current) setBusy(false) }
  }
  let chooseTarget = (id: string) => {
    revision.current++; setBusy(false); setTarget(id); setPreview(null); setError(null); setSetupConfirmed(false)
  }
  let changeDestination = (value: string) => {
    revision.current++; setBusy(false); setDestination(value); setPreview(null); setSetupConfirmed(false)
  }
  let confirm = async () => {
    if (!source || !target || !preview) return
    setBusy(true); setError(null)
    let operationId = machineSecurity().randomId()
    monitor(operationId, request)
    try {
      let result = await request({ action: "move_start", operation_id: operationId, pane_id: sourcePane, execution_id: source.execution_id, target, destination, setup: setupConfirmed })
      if (mounted.current) { observedActive.current = true; setOperation(result) }
    } catch (error) { if (mounted.current) setError(machineErrorMessage(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  let updateOperation = async (action: string) => {
    if (!operation) return
    setBusy(true); setError(null)
    try { await request({ action, operation_id: operation.operation_id }) }
    catch (error) { if (mounted.current) setError(machineErrorMessage(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  let cancel = () => updateOperation("move_cancel")
  let recover = () => updateOperation("move_recover")
  let rollback = () => rollbackConfirmed ? void updateOperation("move_rollback") : setRollbackConfirmed(true)
  let toggleSecurity = () => setShowSecurity((visible) => !visible)
  let confirmSetup = () => setSetupConfirmed((confirmed) => !confirmed)
  let closeTerminal = () => setTerminal(null)
  let openRemote = () => {
    if (!operation?.remote?.pane_id) return
    let value = { machine: operation.target, pane: operation.remote.pane_id, tmuxSession: operation.remote.tmux_session }
    if (operation.state === "setting_up") setTerminal(value)
    else void openDestination(value)
  }
  let running = operation && !terminalStates.has(operation.state)
  return <View style={styles.page}>
    <Text style={styles.title}>Move from {sourceName}</Text>
    <Text style={styles.hint}>Continue this conversation on another machine. Credentials stay on their current machines. Once the handoff is verified, the original agent stops and the remote waits for your next message.</Text>
    <AddMachineButton />
    {!targets.length && <Text style={styles.hint}>Add another machine to choose a destination.</Text>}
    {!running && targets.map((machine) => {
      let select = () => chooseTarget(machine.id)
      let selected = machine.id === target
      let description = !machine.online ? "Offline" : !machine.capabilities.includes("secure_move_v1") ? "Verify keys and enable Secure Move on this machine" : "Online"
      return <View key={machine.id} style={styles.target}>
        <Text style={styles.title}>{machine.name}{selected ? " · Selected" : ""}</Text>
        <Text style={styles.hint}>{description}</Text>
        <MachineActionButton label={selected ? "Selected" : "Choose target"} disabled={!machine.online || busy} onPress={select} />
      </View>
    })}
    <MachineActionButton label={showSecurity ? "Hide identity setup" : "Verify identities"} onPress={toggleSecurity} />
    {showSecurity && <View style={styles.section}>
      <Text style={styles.title}>This client's public identity</Text>
      <Text style={styles.hint}>On both machines, verify this fingerprint and enroll the public identity with cwtctl move trust-client. Also enroll each machine's identity on the other using trust-machine, then run cwtctl move enable. This disables unsigned remote commands on those machines.</Text>
      {identity && <><Text selectable style={styles.code}>{JSON.stringify(identity.identity)}</Text><Text selectable style={styles.code}>Fingerprint: {identity.fingerprint}</Text></>}
      {sourceMachine && <MachineIdentityInput machineId={sourceMachine} label="Source machine identity" onVerified={refreshTrust} />}
      {target && <MachineIdentityInput key={target} machineId={target} label="Target machine identity" onVerified={refreshTrust} />}
      <Text style={styles.hint}>Move payloads are encrypted end to end. Terminal output still uses the current relay connection.</Text>
    </View>}
    {!running && target && <View style={styles.section}>
      <Text style={styles.title}>Destination repository</Text>
      <TextInput accessibilityLabel="Destination repository path" editable={!busy} value={destination} onChangeText={changeDestination} autoCorrect={false} autoCapitalize="none" style={styles.input} />
      <Text style={styles.hint}>Choose a repository path, for example ~/workspace/my-project. Move creates a fresh .worktrees/move-… checkout inside it.</Text>
      <MachineActionButton label={busy ? "Checking…" : "Check readiness"} disabled={busy || !targetMachine?.online || !destination.trim()} onPress={checkReadiness} />
      {!known[target] && <Text style={styles.hint}>Verify the target's identity before checking readiness.</Text>}
    </View>}
    {!running && preview && <View style={styles.section}>
      <Text style={styles.title}>Confirm move to {targetMachine?.name}</Text>
      <Text style={styles.hint}>{source?.provider} · {preview.target.provider_version}{source?.model ? ` · ${source.model}` : ""}</Text>
      <Text selectable style={styles.code}>{preview.target.destination}</Text>
      <Text style={styles.hint}>Copies reachable Git history, staged and unstaged changes, and these additional files:</Text>
      <Text selectable style={styles.code}>{preview.files?.join("\n") || "No additional files"}</Text>
      <Text style={styles.hint}>Ignored files are not copied. Excluded working files: {preview.excluded?.join(", ") || "None"}. Previously committed sensitive files and sensitive content in the conversation can still be included.</Text>
      {preview.target.setup_available && <><Text style={styles.hint}>{preview.target.missing_tools?.length ? `Missing project tools: ${preview.target.missing_tools.join(", ")}. ` : "Project dependencies may need installation. "}A separate setup conversation can prepare this project using target credentials and ask before privileged operations.</Text><MachineActionButton label={setupConfirmed ? "Remote setup confirmed" : "Confirm remote project setup"} disabled={busy} onPress={confirmSetup} /></>}
      <MachineActionButton label="Confirm move" disabled={busy || (!!preview.target.missing_tools?.length && !setupConfirmed)} onPress={confirm} />
    </View>}
    {operation && <View style={styles.section}>
      <Text accessibilityLiveRegion="polite" style={styles.title}>{operation.progress}</Text>
      {operation.error && <Text style={styles.error}>{operation.error}</Text>}
      {running && !irreversibleStates.has(operation.state) && <MachineActionButton label="Cancel move" disabled={busy} onPress={cancel} />}
      {running && <MachineActionButton label="Check handoff" disabled={busy} onPress={recover} />}
      {operation.state === "needs_recovery" && <>
        <Text style={styles.hint}>Recovery stops the target's conversation and setup before restoring the original agent. Changes made on the target remain in its worktree.</Text>
        <MachineActionButton label={rollbackConfirmed ? "Confirm stop target and restore source" : "Stop target and restore source"} tone="danger" disabled={busy} onPress={rollback} />
      </>}
      {operation.remote?.pane_id && <MachineActionButton label={operation.state === "setting_up" ? "Open setup terminal" : "Open remote conversation"} onPress={openRemote} />}
    </View>}
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {terminal && <MachineTerminalScreen machineId={terminal.machine} paneId={terminal.pane} tmuxSession={terminal.tmuxSession} title="Moved conversation" onClose={closeTerminal} />}
  </View>
}

export let MoveButton = ({ paneId }: { paneId: string }) => {
  let navigation = useMachineNavigation()
  let [open, setOpen] = useState(false)
  let close = () => setOpen(false)
  let show = () => navigation ? navigation.push({ title: "Move", content: (dismiss) => <MovePanel paneId={paneId} onClose={dismiss} /> }) : setOpen(true)
  return <>
    <MachineActionButton label="Move" accessibilityLabel="Move conversation to another machine" onPress={show} style={styles.moveButton} />
    {open && <MachineModal title="Move" onClose={close}><MovePanel paneId={paneId} onClose={close} /></MachineModal>}
  </>
}

export let LocalMoveHeader = ({ paneId }: { paneId: string }) => {
  let state = useMachines()
  let resource = splitResource(paneId)
  if (resource) return null
  let name = state.machines.find((machine) => machine.id === local?.machineId())?.name ?? "This Mac"
  return <View style={styles.localHeader}><Text style={styles.hint}>{name}</Text><MoveButton paneId={paneId} /></View>
}
let styles = StyleSheet.create({
  page: { padding: 16, gap: 16 },
  section: { gap: 12 },
  target: { padding: 16, gap: 8, backgroundColor: colors.surface, borderRadius: 16 },
  title: { color: colors.text, fontWeight: "600", fontSize: 16 },
  hint: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
  code: { color: colors.text, fontSize: 12, lineHeight: 18 },
  input: { color: colors.text, padding: 12, minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  error: { color: "#f87171", fontSize: 13, lineHeight: 20 },
  moveButton: { minHeight: 30, paddingHorizontal: 12 },
  localHeader: { flexDirection: "row", alignItems: "center", gap: 12, justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 8 },
})
