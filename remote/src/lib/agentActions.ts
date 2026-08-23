import type { AgentActionRun } from "../types/messages"

const listeners = new Map<string, Set<(run: AgentActionRun) => void>>()

export function dispatchAgentActionProgress(run: AgentActionRun) {
  for (const listener of listeners.get(run.run_id) ?? []) listener(run)
}

export function subscribeAgentActionProgress(runId: string, listener: (run: AgentActionRun) => void) {
  const runListeners = listeners.get(runId) ?? new Set()
  runListeners.add(listener)
  listeners.set(runId, runListeners)
  return () => {
    runListeners.delete(listener)
    if (runListeners.size === 0) listeners.delete(runId)
  }
}
