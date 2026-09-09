import { useState, useRef } from "react"
import { View, Text, Pressable, TextInput, ScrollView, StyleSheet } from "react-native"
import {
  useMachines,
  selectMachine,
  filterMachine,
  machineRequest,
  machineHostRequest,
  newOperationId,
  clearMachineError,
  machineErrorMessage,
  retryMachines,
  type MachineMessage,
} from "./client"

type Props = {
  presentation?: "compact" | "panel"
  onOpenAccount?: () => void
  localMachineId?: string
  api?: (method: string, path: string, body?: MachineMessage) => Promise<MachineMessage>
  approvePairing: (code: string) => Promise<unknown>
  localRequest?: (request: MachineMessage) => Promise<MachineMessage>
}
export let MachinesPanel = ({ approvePairing, localRequest, api, onOpenAccount, localMachineId, presentation = "compact" }: Props) => {
  let styles = presentation === "panel" ? desktopStyles : compactStyles
  let state = useMachines()
  let [tab, setTab] = useState("agents")
  let [expanded, setExpanded] = useState(false)
  let cancelled = useRef(false)
  let [modelProvider, setModelProvider] = useState("codex")
  let [modelNames, setModelNames] = useState("")
  let [shares, setShares] = useState<MachineMessage[]>([])
  let [removeConfirm, setRemoveConfirm] = useState(false)
  let [code, setCode] = useState("")
  let [path, setPath] = useState("~")
  let [url, setUrl] = useState("")
  let [branch, setBranch] = useState("")
  let [prompt, setPrompt] = useState("")
  let [provider, setProvider] = useState("codex")
  let [model, setModel] = useState("")
  let [cron, setCron] = useState("")
  let [jobName, setJobName] = useState("")
  let [output, setOutput] = useState<MachineMessage | null>(null)
  let [busy, setBusy] = useState(false)
  let [error, setError] = useState<string | null>(null)
  let [localPath, setLocalPath] = useState("")
  let [selectedFiles, setSelectedFiles] = useState("")
  let [transfer, setTransfer] = useState<{
    id: string
    direction: "send" | "retrieve"
    manifest: MachineMessage
    source: string
    destination: string
    machine: string
  } | null>(null)
  let [progress, setProgress] = useState("")
  let [operation, setOperation] = useState<{ id: string; machine: string } | null>(null)
  let machine = state.machines.find((m) => m.id === state.selected)
  let models: Record<string, string[]> = machine
    ? (state.snapshots[machine.id]?.settings_response?.enabled_models ?? {})
    : {}
  let choose = (id: string) => {
    selectMachine(id)
    setPath("~")
    setModel("")
    setOutput(null)
    setTransfer(null)
    setShares([])
    setRemoveConfirm(false)
    setProgress("")
    setModelNames("")
  }
  let act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    clearMachineError()
    try {
      await work()
    } catch (e) {
      setError(machineErrorMessage(e, "Operation failed"))
    } finally {
      setBusy(false)
    }
  }
  let host = async (request: MachineMessage) => {
    if (!machine) throw new Error("Choose a machine")
    if (!machine.capabilities.includes("host_management"))
      throw new Error("Update this host to use machine management")
    let result = await machineHostRequest(machine.id, request, 120_000)
    setOutput(result)
    return result
  }
  let approve = () =>
    void act(async () => {
      await approvePairing(code)
      setCode("")
      setProgress("Machine approved; waiting for host setup to finish")
    })
  let browse = () =>
    void act(() =>
      host({ action: "list_directory", path }).then((result) => {
        setPath(result.path)
      }),
    )
  let repository = () => void act(() => host({ action: "repository", path }))
  let clone = () =>
    void act(() => {
      let id = newOperationId()
      setOperation({ id, machine: machine!.id })
      return host({ action: "clone_repository", operation_id: id, url, path })
    })
  let worktree = () =>
    void act(() => {
      let id = newOperationId()
      setOperation({ id, machine: machine!.id })
      return host({ action: "create_worktree", operation_id: id, path, branch, base: "HEAD" })
    })
  let inspectOperation = () =>
    void act(async () => {
      if (operation)
        setOutput(
          await machineHostRequest(operation.machine, {
            action: "operation",
            operation_id: operation.id,
          }),
        )
    })
  let start = () =>
    void act(async () => {
      if (!machine?.online) throw new Error("Choose an online machine")
      if (provider !== "shell" && models[provider] !== undefined && (!model || !models[provider].includes(model)))
        throw new Error("Choose an enabled model on this machine")
      let folder = await machineHostRequest(machine.id, { action: "list_directory", path })
      let operationId = newOperationId()
      setOperation({ id: operationId, machine: machine.id })
      let result = await machineRequest(machine.id, {
        type: "run_agent",
        prompt,
        work_dir: folder.path,
        provider,
        model: model || undefined,
        operation_id: operationId,
      })
      setOutput(result)
      setProgress("Agent started on " + machine.name)
    })
  let createJob = () =>
    void act(async () => {
      if (!machine) throw new Error("Choose a machine")
      let folder = await machineHostRequest(machine.id, { action: "list_directory", path })
      let result = await machineRequest(machine.id, {
        type: "create_job",
        name: jobName,
        job_type: "job",
        path: folder.path,
        prompt,
        cron,
        group: "",
        operation_id: newOperationId(),
      })
      setOutput(result)
    })
  let preview = (direction: "send" | "retrieve") =>
    void act(async () => {
      if (!machine || !localRequest) throw new Error("Desktop transfer support unavailable")
      let id = newOperationId()
      let source = direction === "send" ? localPath : path
      let destination = direction === "send" ? path : localPath
      let request = {
        action: "transfer_prepare",
        operation_id: id,
        path: source,
        files: selectedFiles
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      }
      let manifest =
        direction === "send"
          ? await localRequest(request)
          : await machineHostRequest(machine.id, request, 120_000)
      setTransfer({ id, direction, manifest, source, destination, machine: machine.id })
      setProgress("Snapshot ready to review")
    })
  let transferNow = () =>
    void act(async () => {
      cancelled.current = false
      if (!transfer || !localRequest) return
      let { id, direction, manifest, destination, machine: target } = transfer
      let source = (request: MachineMessage) =>
        direction === "send" ? localRequest!(request) : machineHostRequest(target, request, 120_000)
      let receive = (request: MachineMessage) =>
        direction === "send" ? machineHostRequest(target, request, 120_000) : localRequest!(request)
      let result = await receive({
        action: "transfer_begin",
        operation_id: id,
        path: destination,
        size: manifest.size,
        sha256: manifest.sha256,
      })
      let offset = result.offset
      while (offset < manifest.size) {
        if (cancelled.current) throw new Error("Transfer cancelled")
        let chunk = await source({ action: "transfer_read", operation_id: id, offset })
        if (chunk.offset <= offset) throw new Error("Transfer source ended unexpectedly")
        let ack = await receive({
          action: "transfer_write",
          operation_id: id,
          offset,
          data: chunk.data,
        })
        offset = ack.offset
        setProgress(`Transferring ${Math.round((offset / manifest.size) * 100)}%`)
      }
      if (cancelled.current) throw new Error("Transfer cancelled")
      result = await receive({ action: "transfer_finish", operation_id: id })
      setOutput(result)
      setTransfer(null)
      setProgress("Transfer complete: " + result.path)
    })
  let cancel = () => {
    cancelled.current = true
    void act(async () => {
      if (!transfer || !localRequest) return
      let request = { action: "transfer_cancel", operation_id: transfer.id }
      await Promise.all([localRequest(request), machineHostRequest(transfer.machine, request)])
      setTransfer(null)
      setProgress("Transfer cancelled")
    })
  }
  let saveModels = () =>
    void act(async () => {
      if (!machine || !["codex", "claude", "opencode", "agy"].includes(modelProvider))
        throw new Error("Choose a supported provider")
      await host({
        action: "set_models",
        models: {
          ...models,
          [modelProvider]: modelNames
            .split("\n")
            .map((name) => name.trim())
            .filter(Boolean),
        },
      })
      await machineRequest(machine.id, { type: "get_settings" })
      setProgress("Enabled models saved on " + machine.name)
    })
  let loadShares = () =>
    void act(async () => {
      if (machine && api) setShares((await api("GET", `/machines/${machine.id}/grants`)).shares)
    })
  let toggleGrant = (share: MachineMessage) => () =>
    void act(async () => {
      if (!machine || !api) return
      await api(share.granted ? "DELETE" : "POST", `/machines/${machine.id}/grants`, {
        share_id: share.id,
      })
      setShares((await api("GET", `/machines/${machine.id}/grants`)).shares)
    })
  let removeMachine = () =>
    void act(async () => {
      if (!machine || !api) return
      await api("DELETE", `/devices/${machine.id}`)
      selectMachine(null)
      setRemoveConfirm(false)
    })
  let openTab = (value: string) => () => {
    setTab(value)
    setOutput(null)
  }
  let pickMachine = (id: string) => () => choose(id)
  let pickFilter = (id: string) => () => filterMachine(id)
  let pickProvider = (value: string) => () => {
    setProvider(value)
    setModel("")
  }
  let pickModel = (value: string) => () => setModel(value)
  let pickPath = (value: string) => () => setPath(value)
  let sendPreview = () => preview("send")
  let retrievePreview = () => preview("retrieve")
  let toggleRemove = () => setRemoveConfirm(!removeConfirm)
  let toggle = () => setExpanded(!expanded)
  let clearFilter = () => filterMachine(null)
  let machines = [...state.machines].sort((a, b) =>
    Number(b.id === localMachineId) - Number(a.id === localMachineId) ||
    Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  )
  let machineChoices = (
    <View style={styles.row}>
      {machines.map((m) => (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: m.id === state.selected }}
          aria-pressed={m.id === state.selected}
          key={m.id}
          onPress={pickMachine(m.id)}
          style={[styles.button, styles.machineButton, m.id === state.selected && styles.selectedMachine]}
        >
          <View style={styles.labelRow}>
            <Text style={[styles.text, styles.machineName]}>{m.name}{m.id === localMachineId ? " · This Mac" : ""}</Text>
            {m.id === state.selected && <View style={styles.selectionDot} />}
          </View>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, m.online ? styles.onlineDot : styles.offlineDot]} />
            <Text style={styles.detail}>
              {m.online ? "Online" : "Offline"} · {m.platform === "macos" ? "macOS" : m.platform}
              {m.id !== localMachineId && machines.filter((other) => other.name === m.name).length > 1
                ? " · " + m.id.slice(0, 8) : ""}
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  )
  return (
    <View style={styles.panel}>
      {presentation === "compact" && <View style={styles.row}>
        {presentation === "compact" && <Pressable accessibilityRole="button" onPress={toggle} style={styles.button}>
          <Text style={styles.text}>
            Machines · {state.machines.filter((m) => m.online).length} online
          </Text>
        </Pressable>}
        <Pressable accessibilityRole="button" onPress={clearFilter} style={styles.button}>
          <Text style={styles.text}>All machines</Text>
        </Pressable>
        {state.machines.map((m) => (
          <Pressable
            accessibilityRole="button"
            key={m.id}
            style={styles.button}
            onPress={pickFilter(m.id)}
          >
            <Text style={styles.text}>
              {m.name}
              {state.filter === m.id ? " · selected" : ""}
              {!m.online ? " · offline" : ""}
            </Text>
          </Pressable>
        ))}
      </View>}
      {presentation === "panel" && state.connected && <View style={styles.statusRow}>
        <View style={[styles.statusDot, styles.onlineDot]} />
        <Text style={styles.detail}>Machine list connected · {machines.filter((m) => m.online).length} of {machines.length} online</Text>
      </View>}
      {(error || state.error) && <Text style={styles.error}>{error ?? state.error}</Text>}
      {!state.connected && (
        <View style={styles.row}>
          <View style={[styles.statusDot, state.error ? styles.errorDot : styles.connectingDot]} />
          <Text style={styles.text}>{state.error ? "Machine list unavailable" : "Connecting to your account’s machines…"}</Text>
          {state.error && <Pressable accessibilityRole="button" onPress={retryMachines} style={styles.button}>
            <Text style={styles.text}>Retry connection</Text>
          </Pressable>}
          {state.error && onOpenAccount && <Pressable accessibilityRole="button" onPress={onOpenAccount} style={styles.button}>
            <Text style={styles.text}>Open account settings</Text>
          </Pressable>}
        </View>
      )}
      {(expanded || presentation === "panel") && (
        <ScrollView style={presentation === "panel" ? styles.panelBody : styles.body}>
          {presentation === "panel" && tab !== "pair" && machineChoices}
          <View style={styles.row}>
            {[
              "agents",
              "jobs",
              "repositories",
              ...(localRequest ? ["transfers"] : []),
              "models",
              "access",
              "pair",
            ].map((value) => (
              <Pressable
                accessibilityRole="button"
                key={value}
                onPress={openTab(value)}
                accessibilityState={{ selected: tab === value }}
                aria-pressed={tab === value}
                style={[styles.button, tab === value && styles.activeButton]}
              >
                <View style={styles.labelRow}>
                  {presentation === "panel" && tab === value && <View style={styles.selectionDot} />}
                  <Text style={[styles.text, tab === value && styles.activeText]}>
                    {value === "pair" ? "Add machine" : value[0].toUpperCase() + value.slice(1)}
                    {presentation === "compact" && tab === value ? " · selected" : ""}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
          {tab === "pair" && (
            <>
              <Text style={styles.title}>Add a Linux machine</Text>
              <Text style={styles.text}>
                Install the Linux package, run cwtctl setup on the host, then enter its pairing code
                here.
              </Text>
              <View style={styles.row}>
                <TextInput
                  accessibilityLabel="Pairing code"
                  style={styles.input}
                  placeholder="Pairing code"
                  placeholderTextColor="#989ca6"
                  value={code}
                  onChangeText={setCode}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || !code}
                  onPress={approve}
                  style={styles.button}
                >
                  <Text style={styles.text}>Approve machine</Text>
                </Pressable>
              </View>
            </>
          )}
          {tab !== "pair" && <Text style={styles.title}>{tab[0].toUpperCase() + tab.slice(1)}</Text>}
          {!machine && tab !== "pair" && (
            <>
              <Text style={styles.text}>
                {!state.connected
                  ? "Connect your ClawTab account to load machines and use these controls."
                  : state.machines.length
                    ? (presentation === "panel" ? "Select a machine above" : "Select a machine below") + " to manage its " + tab + "."
                    : "No machines are paired with this account yet. Add a machine to manage its " + tab + "."}
              </Text>
              {state.connected && !state.machines.length && <Pressable accessibilityRole="button" onPress={openTab("pair")} style={styles.button}>
                <Text style={styles.text}>Pair your first machine</Text>
              </Pressable>}
            </>
          )}
          {presentation === "compact" && tab !== "pair" && machineChoices}
          {machine && tab !== "pair" && (
            <>
              <Text style={styles.text}>
                {!machine.online ? "This machine is offline. Start ClawTab on that host to use its controls." : ""}
                {machine.online && (machine.version ? "ClawTab " + machine.version : "Update host for full management")}
              </Text>
              {["agents", "jobs", "repositories", "transfers"].includes(tab) && (
                <>
                  <TextInput
                    accessibilityLabel="Remote folder"
                    style={styles.input}
                    value={path}
                    onChangeText={setPath}
                    placeholder="Remote folder"
                    placeholderTextColor="#989ca6"
                  />
                  <View style={styles.row}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={browse}
                      style={styles.button}
                    >
                      <Text style={styles.text}>Browse folder</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={repository}
                      style={styles.button}
                    >
                      <Text style={styles.text}>Git status and diff</Text>
                    </Pressable>
                  </View>
                </>
              )}
              {tab === "agents" && (
                <>
                  <View style={styles.row}>
                    {[...new Set([...Object.keys(models), ...(machine.rental ? ["codex", "claude", "opencode"] : []), "shell"])].map((value) => (
                      <Pressable
                        accessibilityRole="button"
                        key={value}
                        onPress={pickProvider(value)}
                        style={styles.button}
                      >
                        <Text style={styles.text}>
                          {value}
                          {provider === value ? " · selected" : ""}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={styles.row}>
                    {provider !== "shell" && models[provider] === undefined && <Text style={styles.text}>Uses the provider’s default model.</Text>}
                    {(models[provider] ?? []).map((value) => (
                      <Pressable
                        accessibilityRole="button"
                        key={value}
                        onPress={pickModel(value)}
                        style={styles.button}
                      >
                        <Text style={styles.text}>
                          {value}
                          {model === value ? " · selected" : ""}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </>
              )}
              {tab === "models" && machine.owned && (
                <>
                  <Text style={styles.title}>Enabled models on {machine.name}</Text>
                  <Text style={styles.text}>
                    Use model identifiers supported by the provider installed on this host. One
                    model per line; an empty list disables that provider’s models.
                  </Text>
                  <TextInput
                    accessibilityLabel="Model provider"
                    style={styles.input}
                    value={modelProvider}
                    onChangeText={setModelProvider}
                  />
                  <TextInput
                    accessibilityLabel="Enabled model identifiers"
                    multiline
                    style={styles.input}
                    value={modelNames}
                    onChangeText={setModelNames}
                    placeholder="Model identifiers, one per line"
                    placeholderTextColor="#989ca6"
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={saveModels}
                    style={styles.button}
                  >
                    <Text style={styles.text}>Save enabled models</Text>
                  </Pressable>
                </>
              )}
              {(tab === "agents" || tab === "jobs") && (
                <TextInput
                  accessibilityLabel="Agent prompt"
                  multiline
                  style={styles.input}
                  value={prompt}
                  onChangeText={setPrompt}
                  placeholder="Agent prompt"
                  placeholderTextColor="#989ca6"
                />
              )}
              {tab === "agents" && (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || !machine.online}
                  onPress={start}
                  style={styles.button}
                >
                  <Text style={styles.text}>Start on {machine.name}</Text>
                </Pressable>
              )}
              {tab === "jobs" && (
                <>
                  <Text style={styles.title}>Scheduled job</Text>
                  <TextInput
                    accessibilityLabel="Job name"
                    style={styles.input}
                    value={jobName}
                    onChangeText={setJobName}
                    placeholder="Job name"
                    placeholderTextColor="#989ca6"
                  />
                  <TextInput
                    accessibilityLabel="Cron schedule"
                    style={styles.input}
                    value={cron}
                    onChangeText={setCron}
                    placeholder="Cron schedule in host timezone"
                    placeholderTextColor="#989ca6"
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || !jobName}
                    onPress={createJob}
                    style={styles.button}
                  >
                    <Text style={styles.text}>Create job on {machine.name}</Text>
                  </Pressable>
                </>
              )}
              {tab === "repositories" && (
                <>
                  <Text style={styles.title}>Repository and worktrees</Text>
                  <TextInput
                    accessibilityLabel="Repository URL"
                    style={styles.input}
                    value={url}
                    onChangeText={setUrl}
                    placeholder="Repository URL; credentials are read on the host"
                    placeholderTextColor="#989ca6"
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || !url}
                    onPress={clone}
                    style={styles.button}
                  >
                    <Text style={styles.text}>Clone into selected folder</Text>
                  </Pressable>
                  <TextInput
                    accessibilityLabel="New branch"
                    style={styles.input}
                    value={branch}
                    onChangeText={setBranch}
                    placeholder="New branch from HEAD"
                    placeholderTextColor="#989ca6"
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || !branch}
                    onPress={worktree}
                    style={styles.button}
                  >
                    <Text style={styles.text}>Create worktree</Text>
                  </Pressable>
                </>
              )}
              {operation && (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={inspectOperation}
                  style={styles.button}
                >
                  <Text style={styles.text}>Check operation</Text>
                </Pressable>
              )}
              {tab === "transfers" && localRequest && (
                <>
                  <Text style={styles.title}>Send or retrieve working changes</Text>
                  <TextInput
                    accessibilityLabel="Local repository"
                    style={styles.input}
                    value={localPath}
                    onChangeText={setLocalPath}
                    placeholder="Local repository path"
                    placeholderTextColor="#989ca6"
                  />
                  <TextInput
                    accessibilityLabel="Additional files"
                    multiline
                    style={styles.input}
                    value={selectedFiles}
                    onChangeText={setSelectedFiles}
                    placeholder="Optional individual files, one relative path per line"
                    placeholderTextColor="#989ca6"
                  />
                  <View style={styles.row}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy || !localPath}
                      onPress={sendPreview}
                      style={styles.button}
                    >
                      <Text style={styles.text}>Preview send</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy || !localPath}
                      onPress={retrievePreview}
                      style={styles.button}
                    >
                      <Text style={styles.text}>Preview retrieve</Text>
                    </Pressable>
                  </View>
                  {transfer && (
                    <>
                      <Text style={styles.text}>
                        {transfer.source} → {transfer.destination} · {transfer.manifest.size} bytes
                      </Text>
                      <Text selectable style={styles.code}>
                        {transfer.manifest.changes}
                      </Text>
                      <Text style={styles.text}>
                        This snapshot includes the entire Git history reachable from HEAD, including
                        any previously committed credentials. Extra files:{" "}
                        {Object.keys(transfer.manifest.files).join(", ") || "None"}
                      </Text>
                      <Text style={styles.text}>
                        Excluded working changes: {transfer.manifest.excluded.join(", ") || "None"}
                      </Text>
                      <View style={styles.row}>
                        <Pressable
                          accessibilityRole="button"
                          disabled={busy}
                          onPress={transferNow}
                          style={styles.button}
                        >
                          <Text style={styles.text}>Transfer into a fresh worktree</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          onPress={cancel}
                          style={styles.button}
                        >
                          <Text style={styles.text}>Cancel transfer</Text>
                        </Pressable>
                      </View>
                    </>
                  )}
                </>
              )}
              {tab === "access" && api && machine.owned && (
                <>
                  <Text style={styles.title}>Machine access</Text>
                  <Text style={styles.text}>
                    New machines are private. Select which existing workspace guests can access this
                    machine; their workspace group restrictions still apply.
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={loadShares}
                    style={styles.button}
                  >
                    <Text style={styles.text}>Manage guest access</Text>
                  </Pressable>
                  {shares.map((share) => (
                    <Pressable
                      accessibilityRole="button"
                      key={share.id}
                      disabled={busy}
                      onPress={toggleGrant(share)}
                      style={styles.button}
                    >
                      <Text style={styles.text}>
                        {share.email} · {share.granted ? "Revoke access" : "Grant access"}
                      </Text>
                    </Pressable>
                  ))}
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={toggleRemove}
                    style={styles.button}
                  >
                    <Text style={styles.text}>Remove machine</Text>
                  </Pressable>
                  {removeConfirm && (
                    <>
                      <Text style={styles.text}>
                        This revokes the host credential and disconnects clients. Agents continue
                        running on the host.
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={removeMachine}
                        style={styles.button}
                      >
                        <Text style={styles.text}>Confirm removal of {machine.name}</Text>
                      </Pressable>
                    </>
                  )}
                </>
              )}
              {output?.entries?.map(
                (entry: MachineMessage) =>
                  entry.directory && (
                    <Pressable
                      accessibilityRole="button"
                      key={entry.name}
                      onPress={pickPath(output.path.replace(/\/$/, "") + "/" + entry.name)}
                      style={styles.button}
                    >
                      <Text style={styles.text}>{entry.name}/</Text>
                    </Pressable>
                  ),
              )}
              {output && !output.entries && (
                <Text selectable style={styles.code}>
                  {output.status && typeof output.status === "string" ? output.status : ""}
                  {output.staged ? "\nStaged\n" + output.staged : ""}
                  {output.unstaged ? "\nUnstaged\n" + output.unstaged : ""}
                  {output.path || output.result?.path
                    ? "\n" + (output.path ?? output.result.path)
                    : ""}
                  {output.message ? "\n" + output.message : ""}
                  {output.error ? "\n" + output.error : ""}
                </Text>
              )}
              {output?.worktrees?.map((tree: MachineMessage) => (
                <Pressable
                  accessibilityRole="button"
                  key={tree.path}
                  onPress={pickPath(tree.path)}
                  style={styles.button}
                >
                  <Text style={styles.text}>
                    {tree.branch ?? "Detached"} · {tree.path}
                  </Text>
                </Pressable>
              ))}
            </>
          )}
          {(busy || progress) && (
            <Text style={styles.text}>
              {busy ? "Working… " : ""}
              {progress}
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  )
}
let createStyles = (desktop: boolean) => StyleSheet.create({
  panel: { backgroundColor: desktop ? "transparent" : "#202226", padding: 8, gap: 8 },
  panelBody: { paddingRight: 8 },
  body: { maxHeight: 440, paddingRight: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingVertical: 4 },
  title: { color: desktop ? "var(--text-primary)" : "#fff", fontWeight: "600", marginTop: 18, marginBottom: 8 },
  text: { color: desktop ? "var(--text-primary)" : "#e5e7eb", fontSize: 13 },
  detail: { color: desktop ? "var(--text-secondary)" : "#b6bbc5", fontSize: 12 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 5 },
  statusDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0, alignSelf: "center" },
  onlineDot: { backgroundColor: desktop ? "var(--success-color, #30d158)" : "#4ade80" },
  offlineDot: { backgroundColor: desktop ? "var(--text-muted, #a1a1a6)" : "#989ca6" },
  errorDot: { backgroundColor: desktop ? "var(--danger-color, #ff3b30)" : "#ffabab" },
  connectingDot: { backgroundColor: desktop ? "var(--warning-color, #ff9f0a)" : "#fbbf24" },
  selectionDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: desktop ? "var(--accent-color, #5c6bc0)" : "#9fa8da" },
  machineName: { fontWeight: "600" },
  activeText: { color: desktop ? "var(--accent-color, #5c6bc0)" : "#fff", fontWeight: "600" },
  error: { color: desktop ? "var(--error-color, #c53030)" : "#ffabab", padding: 8 },
  code: { fontFamily: "monospace", color: desktop ? "var(--text-secondary)" : "#d1d5db", fontSize: 12, padding: 8 },
  button: {
    backgroundColor: desktop ? "var(--bg-tertiary)" : "#353942",
    paddingVertical: 9,
    paddingHorizontal: desktop ? 15 : 9,
    borderRadius: desktop ? 999 : 6,
    borderWidth: desktop ? 1 : 0,
    borderColor: "transparent",
    alignSelf: "flex-start",
    marginVertical: 3,
  },
  machineButton: { borderWidth: 1, borderColor: desktop ? "var(--border-light)" : "transparent", borderRadius: desktop ? 16 : 6, paddingVertical: 12, minWidth: desktop ? 160 : undefined },
  selectedMachine: { borderColor: desktop ? "var(--accent-color, #5c6bc0)" : "#9fa8da", backgroundColor: desktop ? "var(--accent-bg)" : "#353942" },
  activeButton: { backgroundColor: desktop ? "var(--accent-hover)" : "#4b5262", borderColor: desktop ? "var(--accent-color, #5c6bc0)" : "transparent" },
  input: {
    borderColor: desktop ? "var(--border-color)" : "#50545d",
    borderWidth: 1,
    borderRadius: desktop ? 12 : 6,
    padding: 10,
    color: desktop ? "var(--text-primary)" : "#fff",
    minWidth: 180,
    marginVertical: 5,
  },
})

let compactStyles = createStyles(false)
let desktopStyles = createStyles(true)
