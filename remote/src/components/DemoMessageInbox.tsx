import { useMemo } from "react"
import { Platform } from "react-native"
import { useRouter } from "expo-router"
import { messagePending } from "@clawtab/shared"
import { useDemoMessages } from "../demo/messages"
import { isMessageTodoCommand } from "../lib/messageTodosController"
import { messageSurfaceController } from "../lib/messageSurfaceController"
import { surfaceRecord } from "../lib/messagePresentation"
import { MessageSurface } from "./MessageSurface"
import type { MessageSurfaceProps } from "./messageSurfaceTypes"

export function DemoMessageInbox(props: Omit<MessageSurfaceProps, "snapshot" | "onCommand"> & { onNavigateAway?: () => void }) {
  const records = useDemoMessages(state => state.records)
  const tasks = useDemoMessages(state => state.tasks)
  const router = useRouter()
  const controller = useMemo(() => messageSurfaceController({
    records: () => useDemoMessages.getState().records,
    machines: () => [],
    update: record => useDemoMessages.getState().update(record),
    navigate: record => {
      props.onNavigateAway?.()
      router.push({ pathname: "/demo-agent", params: { id: record.request.source.pane_id?.replace(/^demo-machine::/, ""), kind: "process" } })
    },
    host: async (_machine, command) => {
      if (command.op === "context") return { log: "Draft ready for review.\nWaiting for your decision.", models: [], plugins: [] }
      if (command.op === "session_targets") return { targets: [] }
      const record = useDemoMessages.getState().records.find(record => record.id === command.id)
      return record ?? {}
    },
    act: async action => {
      const record = useDemoMessages.getState().records.find(record => record.id === action.id)
      if (!record) return
      useDemoMessages.getState().update({ ...record, updated_at: Date.now(),
        ...(action.op === "dismiss" ? { dismissed_at: Date.now() } : {
          status: "answered", response: { action_id: action.action_id ?? "decide", text: action.text, decisions: action.decisions },
        }),
      })
    },
  }), [router, props.onNavigateAway])
  const snapshot = useMemo(() => ({
    type: "snapshot", remote: true, native_chrome: Platform.OS !== "web" && !props.popup,
    visible: props.active !== false, records: records.map(surfaceRecord), pending_count: records.filter(messagePending).length,
    todos: { items: tasks },
    settings: { preview_seconds: 8, hover_expand: false, placement: "right" },
  }), [records, tasks, props.popup, props.active])
  return <MessageSurface {...props} snapshot={snapshot} onCommand={async command => {
    if (!isMessageTodoCommand(command)) return controller.execute(command)
    const demo = useDemoMessages.getState()
    if (command.op === "todo_update" && typeof command.checked === "boolean") demo.updateTask(String(command.id), command.checked)
    if (command.op === "todo_focus" && demo.tasks.some(task => task.id === command.id)) {
      props.onNavigateAway?.()
      router.push({ pathname: "/demo-agent", params: { id: "demo-codex", kind: "process" } })
    }
    return { items: useDemoMessages.getState().tasks }
  }} />
}
