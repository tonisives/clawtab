import { useEffect, useRef, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { colors } from "../theme/colors"
import { machineHostRequest, machineRequest, newOperationId, selectMachine, useMachines } from "./client"
import { RENTAL_AGENTS } from "./Rentals"
import { MachineTerminalScreen } from "./Terminal"

type Api = (method: string, path: string, body?: Record<string, unknown>) => Promise<any>
type Workspace = { id: string; machine_id: string | null; state: string; delete_at: string | null; error: string | null; setup: Record<string, any> }
type Status = { enabled: boolean; eligible: boolean; workspace: Workspace | null }
type Terminal = { pane_id: string; tmux_session: string; machine: string; login: boolean }

export let HostedWorkspacePanel = ({ api, autoStart = false }: { api: Api; autoStart?: boolean }) => {
  let machines = useMachines()
  let [status, setStatus] = useState<Status | null>(null)
  let [usage, setUsage] = useState<Record<string, any> | null>(null)
  let [error, setError] = useState<string | null>(null)
  let [busy, setBusy] = useState(false)
  let pending = useRef(false)
  let started = useRef(false)
  let [loadError, setLoadError] = useState(false)
  let [provider, setProvider] = useState("codex")
  let [terminal, setTerminal] = useState<Terminal | null>(null)
  let workspace = status?.workspace
  let machine = machines.machines.find((candidate) => candidate.id === workspace?.machine_id)
  let online = workspace?.state === "ready" && machine?.online
  let refresh = async () => setStatus(await api("GET", "/hosted-workspace"))
  useEffect(() => {
    let active = true
    let load = async () => {
      try {
        let result: Status = await api("GET", "/hosted-workspace")
        if (active) { setStatus(result); setLoadError(false) }
      } catch {
        if (active) setLoadError(true)
      }
    }
    void load()
    let timer = setInterval(load, 10_000)
    return () => { active = false; clearInterval(timer) }
  }, [api])
  useEffect(() => {
    if (!online || !workspace?.machine_id) { setUsage(null); return }
    let active = true
    let id = workspace.machine_id
    let load = async () => {
      try {
        let result = await machineHostRequest(id, { action: "info" })
        if (active) setUsage(result.hosted)
      } catch { /* Retry while the relay reconnects. */ }
    }
    void load()
    let timer = setInterval(load, 10_000)
    return () => { active = false; clearInterval(timer) }
  }, [online, workspace?.machine_id])
  let act = (work: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    void work().catch((error) => setError(error instanceof Error ? error.message : "Workspace operation failed"))
      .finally(() => { pending.current = false; setBusy(false) })
  }
  let start = () => act(async () => {
    let result: Status = await api("POST", "/hosted-workspace/start")
    setStatus(result)
    if (result.workspace?.machine_id) selectMachine(result.workspace.machine_id)
  })
  useEffect(() => {
    if (!autoStart || started.current || !status?.enabled || !status.eligible) return
    if (["provisioning", "ready", "deleting"].includes(workspace?.state ?? "")) return
    started.current = true
    start()
  }, [autoStart, status?.enabled, status?.eligible, workspace?.id, workspace?.state])
  let open = (action: "login" | "agent", restart = false) => () => act(async () => {
    if (!workspace?.machine_id) return
    let setup = await api("POST", "/hosted-workspace/setup", { provider, action: restart ? `restart_${action}` : "prepare" })
    let saved = setup[`${action}_terminal`]
    let command = action === "login" ? `${RENTAL_AGENTS.find((agent) => agent.id === provider)?.login}; exit` : ""
    let result
    try {
      result = saved ?? await machineRequest(workspace.machine_id, {
        type: "run_agent", provider: action === "login" ? "shell" : provider, prompt: command,
        work_dir: "/home/clawtab/workspace", operation_id: setup[`${action}_operation_id`],
      }, 120_000)
    } catch (error) {
      if (error instanceof Error && error.message.includes("Both included workspace sessions are in use")) {
        await api("POST", "/hosted-workspace/setup", { provider, action: `restart_${action}` })
      }
      throw error
    }
    if ((!saved && !result.success) || !result.pane_id || !result.tmux_session) {
      if (result.status === "rejected") await api("POST", "/hosted-workspace/setup", { provider, action: `restart_${action}` })
      throw new Error(result.error ?? "Could not start a session")
    }
    if (!saved) await api("POST", "/hosted-workspace/setup", { provider, action, terminal: { pane_id: result.pane_id, tmux_session: result.tmux_session } })
    selectMachine(workspace.machine_id)
    setTerminal({ ...result, machine: workspace.machine_id, login: action === "login" })
    await refresh()
  })
  let shell = () => act(async () => {
    if (!workspace?.machine_id) return
    let result = await machineRequest(workspace.machine_id, { type: "run_agent", provider: "shell", prompt: "", work_dir: "/home/clawtab/workspace", operation_id: newOperationId() }, 120_000)
    if (!result.success || !result.pane_id || !result.tmux_session) throw new Error(result.error ?? "Could not open a shell")
    selectMachine(workspace.machine_id)
    setTerminal({ ...result, machine: workspace.machine_id, login: false } as Terminal)
  })
  let choose = () => { if (workspace?.machine_id) selectMachine(workspace.machine_id) }
  if (!status) return autoStart ? <View style={styles.panel}><Text accessibilityLiveRegion="polite" style={styles.detail}>{loadError ? "Could not load your workspace. Retrying…" : "Connecting your Relay workspace…"}</Text></View> : null
  if ((!status.enabled && !workspace) || (!status.eligible && !workspace)) return autoStart ? <View style={styles.panel}><Text style={styles.detail}>{!status.enabled ? "Included workspaces are currently unavailable. Please try again shortly." : "Confirming your Relay subscription… Your workspace will appear here when it is active."}</Text></View> : null
  let setup = workspace?.setup?.providers?.[provider] ?? {}
  return <View style={styles.panel}>
    <Text style={styles.heading}>Your Relay workspace</Text>
    <Text style={styles.detail}>Run two agents at once with your existing AI subscription. Your workspace connects to Relay automatically.</Text>
    {workspace?.state === "suspended" && <Text style={styles.detail}>Your subscription has ended. Renew to restore this workspace before {workspace.delete_at ? new Date(workspace.delete_at).toLocaleDateString() : "the retention period ends"}.</Text>}
    {workspace?.state === "provisioning" && <Text accessibilityLiveRegion="polite" style={styles.detail}>Preparing your workspace… It will connect automatically.</Text>}
    {workspace?.state === "ready" && !online && <Text style={styles.detail}>Connecting to your workspace…</Text>}
    {(error || workspace?.error) && <Text accessibilityRole="alert" style={styles.error}>{error ?? workspace?.error}</Text>}
    {status.eligible && !["provisioning", "ready", "deleting"].includes(workspace?.state ?? "") && <Button disabled={busy || !status.enabled} label={busy ? "Preparing…" : workspace?.state === "suspended" ? "Restore workspace" : "Start included workspace"} onPress={start} />}
    {online && <>
      <Text style={styles.detail}>Choose your agent and sign in to the AI account you already use. Then start your first agent below.</Text>
      {usage && <Text style={styles.detail}>{usage.usage?.sessions ?? "–"}/2 sessions · {usage.usage?.jobs ?? "–"}/2 saved jobs · {usage.usage?.storage_bytes == null ? "–" : Math.ceil(usage.usage.storage_bytes / 1_048_576)} / 500 MiB used{usage.pending_jobs?.length ? ` · ${usage.pending_jobs.length} scheduled jobs waiting` : ""}</Text>}
      <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Choose your agent">{RENTAL_AGENTS.map((agent) => <Pressable key={agent.id} accessibilityRole="radio" accessibilityLabel={agent.name} accessibilityState={{ checked: provider === agent.id }} onPress={() => setProvider(agent.id)} style={[styles.button, provider === agent.id && styles.selected]}><Text style={styles.action}>{agent.name}</Text></Pressable>)}</View>
      <View style={styles.row}>
        <Button label={setup.login_terminal ? "Open sign-in" : `Sign in to ${RENTAL_AGENTS.find((agent) => agent.id === provider)?.name ?? provider}`} onPress={open("login")} disabled={busy} />
        <Button label={setup.agent_terminal ? "Open agent" : "Start agent"} onPress={open("agent")} disabled={busy} />
        {setup.agent_terminal && <Button label="New agent session" onPress={open("agent", true)} disabled={busy} />}
        {setup.login_terminal && <Button label="Sign in again" onPress={open("login", true)} disabled={busy} />}
        <Button label="Open shell" onPress={shell} disabled={busy} />
        <Button label="Select workspace" onPress={choose} />
      </View>
      <Text style={styles.detail}>Sign-in and shell sessions use the same two slots as agents and jobs. Stop a session to free its slot.</Text>
    </>}
    <Text style={styles.detail}>Includes two saved jobs, 0.5 CPU, 500 MiB memory, and 500 MiB storage. Scheduled jobs keep running when you disconnect.</Text>
    {terminal && <MachineTerminalScreen machineId={terminal.machine} paneId={terminal.pane_id} tmuxSession={terminal.tmux_session} title={terminal.login ? "AI account sign-in" : "Included workspace"} signIn={terminal.login} onClose={() => setTerminal(null)} />}
  </View>
}

let Button = ({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) => <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}><Text style={styles.action}>{label}</Text></Pressable>
let styles = StyleSheet.create({
  panel: { padding: 16, gap: 12 }, heading: { color: colors.text, fontSize: 17, fontWeight: "600" },
  detail: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 }, row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { minHeight: 44, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.groupedSurface, paddingHorizontal: 16, justifyContent: "center" },
  selected: { borderColor: colors.accent, backgroundColor: colors.accentBg }, action: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 13 }, disabled: { opacity: 0.5 },
})
