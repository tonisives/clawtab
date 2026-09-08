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
  type MachineMessage,
} from "./client"

type Props = {
  api?: (method: string, path: string, body?: MachineMessage) => Promise<MachineMessage>
  approvePairing: (code: string) => Promise<unknown>
  localRequest?: (request: MachineMessage) => Promise<MachineMessage>
}
export let MachinesPanel = ({ approvePairing, localRequest, api }: Props) => {
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
      setError(e instanceof Error ? e.message : "Operation failed")
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
      if (provider !== "shell" && (!model || !(models[provider] ?? []).includes(model)))
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
  return (
    <View style={styles.panel}>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" onPress={toggle} style={styles.button}>
          <Text style={styles.text}>
            Machines · {state.machines.filter((m) => m.online).length} online
          </Text>
        </Pressable>
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
      </View>
      {(error || state.error) && <Text style={styles.error}>{error ?? state.error}</Text>}
      {expanded && (
        <ScrollView style={styles.body}>
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
                style={styles.button}
              >
                <Text style={styles.text}>
                  {value === "pair" ? "Add machine" : value[0].toUpperCase() + value.slice(1)}
                  {tab === value ? " · selected" : ""}
                </Text>
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
          {tab !== "pair" && <Text style={styles.title}>Machine</Text>}
          <View style={styles.row}>
            {state.machines.map((m) => (
              <Pressable
                accessibilityRole="button"
                key={m.id}
                onPress={pickMachine(m.id)}
                style={styles.button}
              >
                <Text style={styles.text}>
                  {m.name}
                  {m.id === state.selected ? " · selected" : ""} · {m.platform}
                </Text>
              </Pressable>
            ))}
          </View>
          {machine && tab !== "pair" && (
            <>
              <Text style={styles.text}>
                {machine.name} · {machine.online ? "Online" : "Unreachable"} ·{" "}
                {machine.version || "Update host for full management"}
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
                    {[...new Set([...Object.keys(models), "shell"])].map((value) => (
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
let styles = StyleSheet.create({
  panel: { backgroundColor: "#202226", padding: 8, gap: 8 },
  body: { maxHeight: 440, paddingRight: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingVertical: 4 },
  title: { color: "#fff", fontWeight: "600", marginTop: 18, marginBottom: 8 },
  text: { color: "#e5e7eb", fontSize: 13 },
  error: { color: "#ffabab", padding: 8 },
  code: { fontFamily: "monospace", color: "#d1d5db", fontSize: 12, padding: 8 },
  button: {
    backgroundColor: "#353942",
    padding: 9,
    borderRadius: 6,
    alignSelf: "flex-start",
    marginVertical: 3,
  },
  input: {
    borderColor: "#50545d",
    borderWidth: 1,
    borderRadius: 6,
    padding: 10,
    color: "#fff",
    minWidth: 180,
    marginVertical: 5,
  },
})
