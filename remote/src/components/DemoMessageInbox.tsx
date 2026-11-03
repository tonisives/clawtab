import { useMemo } from "react"
import { Platform } from "react-native"
import { messagePending } from "@clawtab/shared"
import { useDemoMessages } from "../demo/messages"
import { isMessageTodoCommand } from "../lib/messageTodosController"
import { surfaceRecord } from "../lib/messagePresentation"
import { MessageSurface } from "./MessageSurface"
import type { MessageSurfaceProps } from "./messageSurfaceTypes"

export function DemoMessageInbox(props: Omit<MessageSurfaceProps, "snapshot" | "onCommand"> & { onNavigateAway?: () => void }) {
  const records = useDemoMessages(state => state.records)
  const tasks = useDemoMessages(state => state.tasks)
  const demoRecords = useMemo(() => records.map(record => ({ ...surfaceRecord(record), details_available: false })), [records])
  const snapshot = useMemo(() => ({
    type: "snapshot", remote: true, demo: true, native_chrome: Platform.OS !== "web" && !props.popup,
    visible: props.active !== false, records: demoRecords, pending_count: records.filter(messagePending).length,
    todos: { items: tasks },
    settings: { preview_seconds: 8, hover_expand: false, placement: "right" },
  }), [records, demoRecords, tasks, props.popup, props.active])
  return <MessageSurface {...props} snapshot={snapshot} onCommand={async command => {
    if (command.op === "todos" || isMessageTodoCommand(command)) return { items: tasks }
    if (command.op === "list") return { records: demoRecords, next_offset: null }
    return demoRecords.find(record => record.id === command.id) ?? {}
  }} />
}
