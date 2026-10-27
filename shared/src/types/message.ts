export type MessageAction = { id: string; label: string; kind: string; value?: string }
export type MessageRecord = {
  id: string
  machine_id: string
  request: {
    kind?: string
    title: string
    body: string
    template: string
    data?: Record<string, unknown>
    actions: MessageAction[]
    media?: { kind: string; src: string; alt: string }[]
    source: { pane_id?: string; job_id?: string; run_id?: string; group?: string; agent_title?: string }
  }
  status: string
  dismissed_at?: number | null
  created_at: number
  updated_at: number
  question_id?: string | null
  error?: string | null
  response?: { action_id: string; text?: string | null } | null
}

export const messageKind = (record: MessageRecord): string => record.request.kind || (
  record.request.template === "update" ? (
    ["agent_finished", "completed"].includes(String(record.request.data?.event)) ? "completed" :
    ["agent_alert", "failed"].includes(String(record.request.data?.event)) ? "failed" : "update"
  ) :
  ["agent-approval", "permission", "social-review"].includes(record.request.template) ? "approval" : "question"
)
export const messageNeedsReply = (record: MessageRecord) => ["question", "approval"].includes(messageKind(record))
export const messagePending = (record: MessageRecord) => !record.dismissed_at && ["pending", "delivering"].includes(record.status)
