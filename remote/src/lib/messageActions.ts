import AsyncStorage from "@react-native-async-storage/async-storage"
import { machineHostRequest, machineState, resourceKey, messagePending, type MessageRecord } from "@clawtab/shared"
import { useMessageStore } from "../store/messages"

type Action = { machine: string; id: string; op: "respond" | "dismiss"; action_id?: string; text?: string }
let queue: Action[] = []
let key: string | null = null
let generation = 0
let flushing: Promise<void> | null = null
let ready: Promise<void> = Promise.resolve()
const save = async () => { if (key) await AsyncStorage.setItem(key, JSON.stringify(queue)) }

export function loadMessageActions(user: string) {
  key = `clawtab_message_actions_${user}`
  const revision = ++generation
  queue = []
  flushing = null
  ready = AsyncStorage.getItem(key).then(raw => {
    if (generation === revision && raw) queue = JSON.parse(raw)
  }).catch(() => {})
  return ready
}

export function resetMessageActions() { generation++; key = null; queue = []; flushing = null }

export async function messageAction(action: Action) {
  await ready
  if (!key) throw new Error("Sign in to reply")
  queue = queue.filter(item => item.machine !== action.machine || item.id !== action.id)
  queue.push(action)
  await save()
  await flushMessageActions()
}

export async function flushMessageActions() {
  await ready
  if (flushing) return flushing
  if (!key || !machineState().connected) return
  const revision = generation
  const attempted = new Set<Action>()
  flushing = (async () => {
    while (true) {
      if (generation !== revision) return
      const action = queue.find(item => !attempted.has(item))
      if (!action) return
      attempted.add(action)
      if (!machineState().machines.some(machine => machine.id === action.machine && machine.online)) continue
      const existing = useMessageStore.getState().records.find(record => record.machine_id === action.machine && record.id === action.id)
      if (existing && !messagePending(existing)) {
        queue = queue.filter(item => item !== action); await save(); continue
      }
      try {
        const result = await machineHostRequest(action.machine, { action: "message", command: { op: action.op, id: action.id, ...(action.action_id ? { action_id: action.action_id } : {}), ...(action.text ? { text: action.text } : {}) } })
        if (generation !== revision) return
        const record = (result.record ?? result) as MessageRecord
        useMessageStore.getState().updateRecord({ ...record, machine_id: action.machine, request: { ...record.request, source: {
          ...record.request.source,
          pane_id: record.request.source.pane_id ? resourceKey(action.machine, record.request.source.pane_id) : undefined,
          job_id: record.request.source.job_id ? resourceKey(action.machine, record.request.source.job_id) : undefined,
        } } })
      } catch (error) {
        if (generation !== revision) return
        if (!/already|resolved|expired|cancelled|not found/i.test(String(error))) throw error
      }
      queue = queue.filter(item => item !== action)
      await save()
    }
  })().finally(() => { if (generation === revision) flushing = null })
  return flushing
}
