import { trackConnectedHost } from "../lib/analytics"
import { useEffect, useCallback } from "react"
import { AppState, Platform } from "react-native"
import {
  connectMachines,
  reconnectMachines,
  machineState,
  subscribeMachines,
  onMachineEvent,
  scopedMessage,
  machineJobs,
  machineProcesses,
  sendResource,
  machineSend,
  splitResource,
  resourceKey,
  messagePending,
  resolveEnabledModels,
  hostModelCatalog,
  type MachineMessage,
} from "@clawtab/shared"
import { getWsUrl, registerMachinePushToken, isInvalidRefreshError, machineApi } from "../api/client"
import { usePinsStore } from "../store/pins"
import { useAuthStore } from "../store/auth"
import { useJobsStore } from "../store/jobs"
import { useNotificationStore } from "../store/notifications"
import { useWsStore } from "../store/ws"
import { setWsSend } from "../lib/wsRuntime"
import { resolveRequest } from "../lib/useRequestMap"
import { dispatchLogChunk } from "./useLogs"
import { dispatchTransportLogChunk } from "../transport/wsTransport"
import {
  dispatchPtyOutput,
  dispatchPtyExit,
  replayActivePtySubscriptions,
  releaseActivePtySubscriptions,
} from "./usePty"
import { terminalCache } from "../lib/terminalCache"
import { dispatchAgentActionProgress } from "../lib/agentActions"
import { useTerminalSettings } from "../store/terminalSettings"
import { getPushToken } from "../lib/notifications"
import type { ClientMessage } from "../types/messages"
import { loadMessageCache, resetMessages, useMessageStore } from "../store/messages"
import { flushMessageActions, loadMessageActions, resetMessageActions } from "../lib/messageActions"

let resetAccountState = () => {
  resetMessages()
  resetMessageActions()
  useNotificationStore.getState().reset()
  useJobsStore.setState(useJobsStore.getInitialState())
  useWsStore.getState().reset()
  terminalCache.clear()
  setWsSend(null)
}

let synchronize = () => {
  let state = machineState()
  let selected = state.machines.find((m) => m.id === state.selected)
    ?? state.machines.find((m) => m.online && m.owned)
    ?? state.machines.find((m) => m.online)
  useWsStore.setState({
    connected: state.connected,
    desktopOnline: selected?.online ?? false,
    desktopDeviceId: selected?.id ?? null,
    desktopDeviceName: selected?.name ?? null,
  })
  let jobs = useJobsStore.getState()
  let snapshot = machineJobs()
  jobs.setJobs(snapshot.jobs, snapshot.statuses)
  jobs.setDetectedProcesses(machineProcesses())
  let messages = Object.entries(state.snapshots).filter(
    ([id]) => !state.filter || state.filter === id,
  )
  let questions = messages.flatMap(
    ([id, snapshot]) => scopedMessage(id, snapshot.claude_questions ?? { questions: [] }).questions,
  )
  const messageSnapshots = messages.filter(([, snapshot]) => snapshot.messages_changed)
  if (messageSnapshots.length) {
    const records = messageSnapshots.flatMap(([machine, snapshot]) => (snapshot.messages_changed.records ?? []).map((record: any) => ({
      ...record, machine_id: machine, request: { ...record.request, source: {
        ...record.request.source,
        pane_id: record.request.source.pane_id ? resourceKey(machine, record.request.source.pane_id) : undefined,
        job_id: record.request.source.job_id ? resourceKey(machine, record.request.source.job_id) : undefined,
      } },
    })))
    useMessageStore.getState().setRecords(records)
    const resolved = new Set(records.filter((record: any) => record.request.data?.question_id && !messagePending(record)).map((record: any) => resourceKey(record.machine_id, record.request.data.question_id)))
    questions = questions.filter((question: MachineMessage) => !resolved.has(question.question_id))
  } else if (messages.length) {
    useMessageStore.getState().setRecords([])
  }
  jobs.setQuestionPanes(questions.map((q: MachineMessage) => q.pane_id))
  jobs.setAgentActivity(
    messages.flatMap(
      ([id, snapshot]) => scopedMessage(id, snapshot.agent_activity ?? { activity: [] }).activity,
    ),
  )
  useNotificationStore.getState().setQuestions(questions)
  useNotificationStore
    .getState()
    .setAutoYesPanes(
      messages.flatMap(
        ([id, snapshot]) => scopedMessage(id, snapshot.auto_yes_panes ?? { pane_ids: [] }).pane_ids,
      ),
    )
  usePinsStore
    .getState()
    .applySharedSnapshot(
      messages.flatMap(
        ([id, snapshot]) =>
          scopedMessage(id, snapshot.pinned_items ?? { type: "pinned_items", items: [] }).items,
      ),
    )
  let hostSettings = state.selected ? state.snapshots[state.selected]?.settings_response : null
  let settings = state.agentModels ?? hostSettings
  jobs.setDesktopSettings(
    resolveEnabledModels(settings?.enabled_models ?? {}, hostModelCatalog(hostSettings), settings?.disabled_models),
    settings?.default_provider ?? "codex",
    settings?.default_model,
  )
}
export let useWebSocket = () => {
  let authenticated = useAuthStore((s) => s.isAuthenticated)
  let userId = useAuthStore((s) => s.userId)
  useEffect(() => {
    if (!authenticated) {
      resetAccountState()
      return
    }
    let active = true
    if (userId) {
      void loadMessageCache(userId)
      void loadMessageActions(userId).then(() => { if (active) return flushMessageActions() }).catch(() => {})
    }
    void useTerminalSettings.getState().hydrate()
    setWsSend(sendResource)
    let wasConnected = false
    let hostConnections = new Map<string, string | undefined>()
    let executions = new Map<string, string | undefined>()
    let unsubscribe = subscribeMachines(() => {
      let nextExecutions = new Map(
        machineProcesses().map((process) => [process.pane_id, process.execution_id]),
      )
      for (let [pane, execution] of executions)
        if (nextExecutions.get(pane) !== execution) terminalCache.delete(pane)
      executions = nextExecutions
      let connected = machineState().connected && machineState().machines.some((m) => m.online)
      if (machineState().connected && machineState().machines.some((machine) => machine.owned && machine.online)) trackConnectedHost()
      let nextHosts = new Map(
        machineState()
          .machines.filter((machine) => machine.online)
          .map((machine) => [machine.id, machine.connection_id]),
      )
      let hostReconnected = [...nextHosts].some(
        ([id, generation]) => !hostConnections.has(id) || hostConnections.get(id) !== generation,
      )
      let replay = connected && (!wasConnected || hostReconnected)
      if (replay) void flushMessageActions().catch(() => {})
      // Sending a subscription can synchronously publish a routing error. Record
      // this generation first so that notification cannot replay it recursively.
      hostConnections = nextHosts
      wasConnected = connected
      synchronize()
      if (replay) replayActivePtySubscriptions()
    })
    let unlisten = onMachineEvent((machine, raw) => {
      let message = scopedMessage(machine, raw)
      if (raw.id) resolveRequest(raw.id, message.type === "run_history" ? message.runs : message)
      switch (message.type) {
        case "pty_output":
          dispatchPtyOutput(message.pane_id, message.data)
          break
        case "pty_exit":
          dispatchPtyExit(message.pane_id)
          break
        case "log_chunk":
          dispatchLogChunk(message.name, message.content)
          dispatchTransportLogChunk(message.name, message.content)
          break
        case "status_update":
          useJobsStore.getState().updateStatus(message.name, message.status)
          break
        case "agent_action_progress":
          dispatchAgentActionProgress(message.run)
          break
      }
    })
    let stop = connectMachines(async () => {
      try {
        return await getWsUrl()
      } catch (error) {
        if (active && isInvalidRefreshError(error)) await useAuthStore.getState().logout()
        throw error
      }
    }, machineApi)
    void getPushToken()
      .then((token) =>
        active && token
          ? registerMachinePushToken(token, Platform.OS === "ios" ? "ios" : "android")
          : undefined,
      )
      .catch(() => {})
    let wasBackgrounded = AppState.currentState === "background"
    let appState = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        // Web dialogs and tab focus can interrupt a pending action if they
        // replace an otherwise healthy socket. Native backgrounding can suspend
        // the network, so those clients still reconnect after resuming.
        let reconnect = !machineState().connected || (Platform.OS !== "web" && wasBackgrounded)
        wasBackgrounded = false
        if (reconnect) reconnectMachines()
        else replayActivePtySubscriptions("resume")
        return
      }
      if (next === "background") wasBackgrounded = true
      releaseActivePtySubscriptions()
      let state = machineState()
      for (let [key, controller] of Object.entries(state.controllers)) {
        let resource = splitResource(key)
        if (resource && controller === state.connectionId)
          machineSend(resource.machine, { type: "release_control", pane_id: resource.id })
      }
    })
    return () => {
      active = false
      appState.remove()
      unlisten()
      unsubscribe()
      stop()
      resetAccountState()
    }
  }, [authenticated, userId])
  let send = useCallback((message: ClientMessage) => sendResource(message), [])
  return { send }
}
import "../lib/machineSecurity"
