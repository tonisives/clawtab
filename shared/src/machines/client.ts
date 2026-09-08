import { useSyncExternalStore } from "react"
import type { DetectedProcess } from "../types/process"
import type { RemoteJob, JobStatus } from "../types/job"

export type Machine = {
  connection_id?: string
  id: string
  name: string
  owned: boolean
  online: boolean
  platform: string
  architecture: string
  version: string
  capabilities: string[]
  last_seen: string | null
}
export type MachineMessage = Record<string, any>
export type MachineState = {
  connected: boolean
  machines: Machine[]
  selected: string | null
  filter: string | null
  connectionId: string | null
  snapshots: Record<string, Record<string, MachineMessage>>
  controllers: Record<string, string | null>
  error: string | null
}
export let newOperationId = () =>
  globalThis.crypto?.randomUUID?.() ??
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    let r = Math.floor(Math.random() * 16)
    return (c === "x" ? r : (r & 3) | 8).toString(16)
  })
export let resourceKey = (machine: string, id: string) => `${machine}::${id}`
export let splitResource = (key: string) => {
  let at = key.indexOf("::")
  return at === 36 ? { machine: key.slice(0, at), id: key.slice(at + 2) } : null
}
export let resourceLabel = (key: string) => splitResource(key)?.id ?? key
let initialState = (): MachineState => ({
  connected: false,
  machines: [],
  selected: null,
  filter: null,
  connectionId: null,
  snapshots: {},
  controllers: {},
  error: null,
})
let state = initialState()
let listeners = new Set<() => void>()
let events = new Set<(machine: string, message: MachineMessage) => void>()
let pending = new Map<
  string,
  {
    resolve: (value: MachineMessage) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()
let socket: WebSocket | null = null
let transferSocket: WebSocket | null = null
let transferConnection: Promise<WebSocket> | null = null
let connectionUrl: (() => Promise<string>) | null = null
let stopConnection: (() => void) | null = null
let retryConnection: (() => void) | null = null
export let retryMachines = () => retryConnection?.()
export let machineErrorMessage = (error: unknown, fallback = "Machine request failed") =>
  error instanceof Error ? error.message : typeof error === "string" && error ? error : fallback
let update = (patch: Partial<MachineState>) => {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}
export let machineState = () => state
export let subscribeMachines = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export let useMachines = () => useSyncExternalStore(subscribeMachines, machineState, machineState)
export let selectMachine = (selected: string | null) => update({ selected })
export let filterMachine = (filter: string | null) => update({ filter })
export let clearMachineError = () => update({ error: null })
export let onMachineEvent = (listener: (machine: string, message: MachineMessage) => void) => {
  events.add(listener)
  return () => {
    events.delete(listener)
  }
}
export let executionFor = (machine: string, pane: string) =>
  state.snapshots[machine]?.detected_processes?.processes?.find(
    (p: MachineMessage) => p.pane_id === pane,
  )?.execution_id

export let machineRequest = (
  machine: string,
  message: MachineMessage,
  timeout = 30_000,
): Promise<MachineMessage> => {
  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN ||
    !state.machines.some((m) => m.id === machine && m.online)
  )
    return Promise.reject(new Error("Machine is offline"))
  let requestId = newOperationId()
  let payload: MachineMessage = { ...message, id: requestId }
  if (typeof payload.pane_id === "string")
    payload.execution_id = executionFor(machine, payload.pane_id)
  if (["run_agent", "run_job", "create_job"].includes(payload.type))
    payload.operation_id ??= newOperationId()
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error("Machine request timed out; check operation status before retrying"))
    }, timeout)
    pending.set(requestId, { resolve, reject, timer })
    socket?.send(
      JSON.stringify({ version: 2, machine_id: machine, request_id: requestId, message: payload }),
    )
  })
}
export let machineHostRequest = async (
  machine: string,
  request: MachineMessage,
  timeout = 30_000,
) => {
  let response = request.action?.startsWith("transfer_")
    ? await transferRequest(machine, request, timeout)
    : await machineRequest(machine, { type: "host_request", request }, timeout)
  if (response.error) throw new Error(response.error)
  return response.result as MachineMessage
}
export let machineSend = (machine: string, message: MachineMessage) => {
  void machineRequest(machine, message).catch((error) => update({ error: error.message }))
}
export let sendResource = (message: MachineMessage) => {
  if (message.type === "set_auto_yes_panes" || message.type === "merge_pinned_items") {
    let field = message.type === "set_auto_yes_panes" ? "pane_ids" : "items"
    for (let machine of state.machines.filter((item) => item.owned && item.online)) {
      let values = (message[field] as string[]).flatMap((value) => {
        let colon = field === "items" ? value.indexOf(":") : -1
        let prefix = colon >= 0 ? value.slice(0, colon + 1) : ""
        let resource = splitResource(value.slice(prefix.length))
        return resource?.machine === machine.id ? [prefix + resource.id] : []
      })
      machineSend(machine.id, { ...message, [field]: values })
    }
    return
  }
  let pinPrefix =
    message.type === "set_pinned_item"
      ? String(message.key).slice(0, String(message.key).indexOf(":") + 1)
      : ""
  let identities = [
    message.pane_id,
    message.name,
    message.run_id,
    message.question_id,
    pinPrefix ? String(message.key).slice(pinPrefix.length) : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .map(splitResource)
    .filter((value) => value !== null)
  let machine = identities[0]?.machine ?? state.selected
  if (!machine || identities.some((resource) => resource.machine !== machine)) {
    let error = "Choose one machine for this request"
    update({ error })
    if (message.id)
      queueMicrotask(() =>
        events.forEach((listener) =>
          listener(machine ?? "", { type: "error", id: message.id, success: false, error }),
        ),
      )
    return
  }
  let payload = { ...message }
  for (let field of ["pane_id", "name", "run_id", "question_id"])
    if (typeof payload[field] === "string") payload[field] = resourceLabel(payload[field])
  if (pinPrefix)
    payload.key = pinPrefix + resourceLabel(String(payload.key).slice(pinPrefix.length))
  let originalId = message.id
  void machineRequest(machine, payload)
    .then((reply) => {
      events.forEach((listener) =>
        listener(machine, { ...reply, ...(originalId ? { id: originalId } : {}) }),
      )
    })
    .catch((error) => {
      update({ error: error.message })
      if (originalId)
        events.forEach((listener) =>
          listener(machine, {
            type: "error",
            id: originalId,
            success: false,
            message: error.message,
            error: error.message,
          }),
        )
    })
}

export let connectMachines = (getUrl: () => Promise<string>) => {
  stopConnection?.()
  connectionUrl = getUrl
  let stopped = false
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let backoff = 1000
  let connecting = false
  let connect = async () => {
    if (stopped || connecting) return
    connecting = true
    try {
      let url = await getUrl()
      if (stopped) return
      let ws = new WebSocket(url.replace(/\/(?:v2\/)?ws\?/, "/v2/ws?"))
      socket = ws
      let watchdog = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) ws.close()
      }, 15_000)
      ws.onopen = () => {
        clearTimeout(watchdog)
        backoff = 1000
        update({ connected: true, error: null })
      }
      ws.onmessage = (event) => {
        if (socket !== ws) return
        let data: MachineMessage
        try {
          data = JSON.parse(event.data)
        } catch {
          return
        }
        if (data.type === "machines") {
          let machines = data.machines as Machine[]
          let known = new Map(
            state.machines.filter((m) => m.online).map((m) => [m.id, m.connection_id]),
          )
          update({
            selected: machines.some((m) => m.id === state.selected) ? state.selected : null,
            filter: machines.some((m) => m.id === state.filter) ? state.filter : null,
            machines,
            connectionId: data.connection_id,
            snapshots: Object.fromEntries(
              Object.entries(state.snapshots).filter(([id]) => machines.some((m) => m.id === id)),
            ),
          })
          for (let machine of machines.filter(
            (m) => m.online && (!known.has(m.id) || known.get(m.id) !== m.connection_id),
          )) {
            machineSend(machine.id, { type: "list_jobs" })
            machineSend(machine.id, { type: "detect_processes" })
            if (machine.owned) machineSend(machine.id, { type: "get_settings" })
          }
          return
        }
        if (data.type === "terminal_control") {
          update({
            controllers: {
              ...state.controllers,
              [resourceKey(data.machine_id, data.pane_id)]: data.controller,
            },
          })
          return
        }
        let request = data.request_id ? pending.get(data.request_id) : null
        if (request) {
          pending.delete(data.request_id)
          clearTimeout(request.timer)
          if (
            data.type === "machine_error" ||
            data.message?.error ||
            data.message?.success === false ||
            data.message?.type === "error"
          )
            request.reject(
              new Error(
                data.message?.error ??
                  data.message?.message ??
                  data.message ??
                  "Machine request failed",
              ),
            )
          else request.resolve(data.message)
        }
        if (data.type === "machine_error") {
          update({
            error: typeof data.message === "string" ? data.message : "Machine request failed",
          })
          return
        }
        if (data.type !== "machine_event") return
        let message = data.message as MachineMessage
        if (
          [
            "jobs_changed",
            "jobs_list",
            "detected_processes",
            "claude_questions",
            "agent_activity",
            "settings_response",
            "auto_yes_panes",
            "pinned_items",
          ].includes(message.type)
        ) {
          let kind = message.type === "jobs_list" ? "jobs_changed" : message.type
          update({
            snapshots: {
              ...state.snapshots,
              [data.machine_id]: { ...state.snapshots[data.machine_id], [kind]: message },
            },
          })
        }
        if (message.type === "status_update") {
          let snapshots = state.snapshots[data.machine_id] ?? {}
          let jobs = snapshots.jobs_changed ?? { type: "jobs_changed", jobs: [], statuses: {} }
          update({
            snapshots: {
              ...state.snapshots,
              [data.machine_id]: {
                ...snapshots,
                jobs_changed: {
                  ...jobs,
                  statuses: { ...jobs.statuses, [message.name]: message.status },
                },
              },
            },
          })
        }
        events.forEach((listener) => listener(data.machine_id, message))
      }
      ws.onclose = () => {
        clearTimeout(watchdog)
        if (socket !== ws) return
        socket = null
        for (let request of pending.values()) {
          clearTimeout(request.timer)
          request.reject(new Error("Connection lost; operation outcome may be pending"))
        }
        pending.clear()
        update({
          connected: false,
          error: "Connection to the machine service was lost. Retrying…",
          machines: state.machines.map((m) => ({ ...m, online: false })),
          controllers: {},
        })
        if (!stopped) {
          reconnect = setTimeout(connect, backoff)
          backoff = Math.min(backoff * 2, 30_000)
        }
      }
      ws.onerror = () => ws.close()
    } catch (error) {
      if (stopped) return
      update({ connected: false, error: machineErrorMessage(error, "Cannot connect to the machine service") })
      if (!stopped) {
        reconnect = setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
    } finally {
      connecting = false
    }
  }
  retryConnection = () => {
    if (stopped || connecting || socket) return
    clearTimeout(reconnect)
    backoff = 1000
    update({ error: null })
    void connect()
  }
  void connect()
  let refresh = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "refresh_machines" }))
    for (let [key, controller] of Object.entries(state.controllers)) {
      let resource = splitResource(key)
      if (resource && controller === state.connectionId)
        machineSend(resource.machine, { type: "renew_control", pane_id: resource.id })
    }
  }, 10_000)
  stopConnection = () => {
    stopped = true
    retryConnection = null
    transferSocket?.close()
    transferSocket = null
    transferConnection = null
    clearInterval(refresh)
    clearTimeout(reconnect)
    let closing = socket
    socket = null
    closing?.close()
    for (let request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error("Disconnected"))
    }
    pending.clear()
    update(initialState())
  }
  return stopConnection
}

export let scopedMessage = (machine: string, message: MachineMessage): MachineMessage => {
  let key = (id: string) => resourceKey(machine, id)
  let out = { ...message }
  for (let field of ["pane_id", "question_id", "run_id", "matched_job"])
    if (typeof out[field] === "string") out[field] = key(out[field])
  if (["status_update", "log_chunk"].includes(out.type)) out.name = key(out.name)
  if (out.jobs)
    out.jobs = out.jobs.map((job: RemoteJob) => ({
      ...job,
      machine_id: machine,
      display_name: job.name,
      name: key(job.name),
      slug: key(job.slug),
    }))
  if (out.statuses)
    out.statuses = Object.fromEntries(
      Object.entries(out.statuses).map(([id, status]) => [
        key(id),
        scopedMessage(machine, status as MachineMessage),
      ]),
    )
  if (out.processes)
    out.processes = out.processes.map((p: DetectedProcess) => ({
      ...p,
      machine_id: machine,
      pane_id: key(p.pane_id),
      matched_job: p.matched_job ? key(p.matched_job) : p.matched_job,
    }))
  for (let field of ["activity", "questions"])
    if (out[field])
      out[field] = out[field].map((item: MachineMessage) => scopedMessage(machine, item))
  if (out.type === "pinned_items")
    out.items = out.items.map((item: string) => {
      let at = item.indexOf(":")
      return item.slice(0, at + 1) + key(item.slice(at + 1))
    })
  if (out.pane_ids) out.pane_ids = out.pane_ids.map(key)
  if (out.status && typeof out.status === "object") out.status = scopedMessage(machine, out.status)
  if (out.detail) out.detail = scopedMessage(machine, out.detail)
  if (out.run) out.run = scopedMessage(machine, out.run)
  if (out.runs)
    out.runs = out.runs.map((run: MachineMessage) => ({
      ...run,
      id: key(run.id),
      job_id: key(run.job_id),
    }))
  return out
}
export let machineJobs = (exclude?: string) => {
  let jobs: RemoteJob[] = []
  let statuses: Record<string, JobStatus> = {}
  for (let machine of state.machines) {
    if (machine.id === exclude || (state.filter && machine.id !== state.filter)) continue
    let snapshot = state.snapshots[machine.id]?.jobs_changed
    if (!snapshot) continue
    let scoped = scopedMessage(machine.id, snapshot)
    jobs.push(...scoped.jobs)
    Object.assign(statuses, scoped.statuses)
  }
  return { jobs, statuses }
}
export let machineProcesses = (exclude?: string): DetectedProcess[] =>
  state.machines
    .filter((m) => m.id !== exclude && (!state.filter || m.id === state.filter))
    .flatMap(
      (m) =>
        scopedMessage(m.id, state.snapshots[m.id]?.detected_processes ?? { processes: [] })
          .processes,
    )

let transferRequest = async (
  machine: string,
  request: MachineMessage,
  timeout: number,
): Promise<MachineMessage> => {
  if (!connectionUrl) throw new Error("Connect to the relay first")
  if (!transferSocket || transferSocket.readyState !== WebSocket.OPEN) {
    transferConnection ??= connectionUrl()
      .then(
        (url) =>
          new Promise<WebSocket>((resolve, reject) => {
            let ws = new WebSocket(url.replace(/\/(?:v2\/)?ws\?/, "/v2/ws?") + "&channel=transfer")
            let timer = setTimeout(() => {
              ws.close()
              reject(new Error("Transfer connection timed out"))
            }, 15_000)
            ws.onopen = () => {
              clearTimeout(timer)
              transferSocket = ws
              resolve(ws)
            }
            ws.onerror = () => {
              clearTimeout(timer)
              ws.close()
              reject(new Error("Transfer connection failed"))
            }
            ws.onclose = () => {
              transferSocket = null
              transferConnection = null
            }
            ws.onmessage = (event) => {
              let value: MachineMessage
              try {
                value = JSON.parse(event.data)
              } catch {
                return
              }
              let waiter = pending.get(value.request_id)
              if (!waiter) return
              clearTimeout(waiter.timer)
              pending.delete(value.request_id)
              if (value.type === "machine_error" || value.message?.error)
                waiter.reject(new Error(value.message?.error ?? value.message))
              else waiter.resolve(value.message)
            }
          }),
      )
      .finally(() => {
        transferConnection = null
      })
    await transferConnection
  }
  let requestId = newOperationId()
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error("Transfer request timed out; retry to resume"))
    }, timeout)
    pending.set(requestId, { resolve, reject, timer })
    transferSocket?.send(
      JSON.stringify({
        version: 2,
        machine_id: machine,
        request_id: requestId,
        message: { type: "host_request", id: requestId, request },
      }),
    )
  })
}
