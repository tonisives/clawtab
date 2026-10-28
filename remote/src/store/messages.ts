import AsyncStorage from "@react-native-async-storage/async-storage"
import { create } from "zustand"
import { messagePending, resourceKey, type MessageRecord, type ClaudeQuestion, type DetectedProcess } from "@clawtab/shared"
import { dismissMessageNotification } from "../lib/notifications"

let cacheKey: string | null = null
let revision = 0
export const useMessageStore = create<{
  records: MessageRecord[]
  setRecords: (records: MessageRecord[]) => void
  updateRecord: (record: MessageRecord) => void
}>((set, get) => ({
  records: [],
  setRecords: records => {
    const previous = get().records
    for (const record of previous) {
      const next = records.find(next => next.machine_id === record.machine_id && next.id === record.id)
      if (messagePending(record) && (!next || !messagePending(next))) void dismissMessageNotification(record.id)
    }
    revision++
    set({ records })
    if (cacheKey) void AsyncStorage.setItem(cacheKey, JSON.stringify(records)).catch(() => {})
  },
  updateRecord: record => {
    const records = get().records
    get().setRecords(records.some(current => current.machine_id === record.machine_id && current.id === record.id)
      ? records.map(current => current.machine_id === record.machine_id && current.id === record.id ? record : current)
      : [record, ...records])
  },
}))

export async function loadMessageCache(user: string) {
  cacheKey = `clawtab_messages_${user}`
  const key = cacheKey
  const current = ++revision
  useMessageStore.setState({ records: [] })
  try {
    const raw = await AsyncStorage.getItem(key)
    if (key === cacheKey && current === revision && raw) useMessageStore.setState({ records: JSON.parse(raw) })
  } catch { /* Keep the live host snapshot when the cache is unavailable. */ }
}

export function resetMessages() {
  cacheKey = null
  revision++
  useMessageStore.setState({ records: [] })
}

export const questionMessage = (records: MessageRecord[], question: ClaudeQuestion) => records.find(record => (
  record.request.data?.question_id && resourceKey(record.machine_id, String(record.request.data.question_id)) === question.question_id
))

export const uncoveredAlerts = (records: MessageRecord[], processes: DetectedProcess[]) => processes.filter(process => (
  !records.some(record => record.request.data?.event === "agent_alert" && record.request.source.pane_id === process.pane_id)
))
