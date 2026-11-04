import { useCallback, useMemo } from "react"
import type { ClaudeQuestion, MessageRecord } from "@clawtab/shared"
import { MessageSurface } from "./MessageSurface"

export function DemoQuestionSurface({ question, output }: { question: ClaudeQuestion; output: string }) {
  const record = useMemo<MessageRecord>(() => ({
    id: question.question_id, machine_id: "demo-machine", question_id: question.question_id,
    status: "pending", created_at: 0, updated_at: 0,
    request: {
      title: "Claude", body: "", template: "question",
      source: { pane_id: question.pane_id, group: "Demo", agent_title: "Claude" },
      actions: question.options.map(option => ({ id: option.number, kind: "choice", label: `${option.number}. ${option.label}` })),
    },
  }), [question])
  const snapshot = useMemo(() => ({
    type: "snapshot", remote: true, demo: true, native_chrome: true, shell_only: true, shell_answers: true, visible: true,
    pending_count: 1, records: [record], shell_cache: { [record.id]: output }, auto_yes_panes: [],
    templates: { templates: [{ id: "question", layout: [{ type: "logs" }] }] },
    settings: { hover_expand: false, placement: "right" },
  }), [question.pane_id, output, record])
  const command = useCallback(async (command: Record<string, unknown>) => {
    if (command.op === "context") return { source: record.request.source, log: output, models: [], plugins: [] }
    if (command.op === "auto_yes") return { auto_yes: false }
    // Keep the sample question pending when an answer is tapped.
    return record
  }, [record, output])
  return <MessageSurface snapshot={snapshot} selection={record.id} onCommand={command} />
}
