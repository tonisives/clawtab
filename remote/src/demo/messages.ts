import { create } from "zustand"
import type { MessageRecord } from "@clawtab/shared"

export const DEMO_SOCIAL_MESSAGE: MessageRecord = {
  id: "demo-x-post",
  machine_id: "demo-machine",
  status: "pending",
  created_at: Date.now(),
  updated_at: Date.now(),
  request: {
    kind: "approval",
    title: "Review the ClawTab post",
    body: "A draft for X. Review the copy before posting.",
    template: "social-review",
    source: { pane_id: "demo-codex", group: "ClawTab", agent_title: "Launch post" },
    data: { targets: [{
      id: "x", platform: "x", account: "@clawtab", revision: "0".repeat(64),
      body: "A quick check from my phone: which agents are running, who needs an answer, and whether the last job finished.\n\nThat’s what I built ClawTab for.\n\nhttps://clawtab.cc",
      media_indices: [],
    }] },
    actions: [{ id: "decide", kind: "choice", label: "Send platform decisions" }],
  },
}

// Demo review decisions stay in memory and never enter the live message store.
export const useDemoMessages = create<{
  records: MessageRecord[]
  update: (record: MessageRecord) => void
}>(set => ({
  records: [DEMO_SOCIAL_MESSAGE],
  update: record => set(state => ({ records: state.records.map(current => current.id === record.id ? record : current) })),
}))
