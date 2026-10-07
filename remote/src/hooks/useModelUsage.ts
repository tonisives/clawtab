import { useEffect, useState } from "react"
import { machineRequest } from "@clawtab/shared"
import type { UsageSnapshot } from "../types/messages"

type UsageResult = { machineId?: string; usage: UsageSnapshot | null; loading: boolean; error: string | null }

export let useModelUsage = (machineId: string | undefined, enabled: boolean) => {
  let [revision, setRevision] = useState(0)
  let [result, setResult] = useState<UsageResult>({ usage: null, loading: false, error: null })
  useEffect(() => {
    if (!machineId || !enabled) return
    let active = true
    setResult((previous) => ({ machineId, usage: previous.machineId === machineId ? previous.usage : null, loading: true, error: null }))
    // Request the displayed machine directly; the global execution target may be unset.
    void machineRequest(machineId, { type: "get_usage" }).then((response) => {
      if (!response.usage) throw new Error("Usage data is unavailable")
      if (active) setResult({ machineId, usage: response.usage, loading: false, error: null })
    }).catch((error) => {
      if (active) setResult((previous) => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) }))
    })
    return () => { active = false }
  }, [machineId, enabled, revision])
  let current = result.machineId === machineId && enabled
  return {
    usage: current ? result.usage : null,
    loading: !!machineId && enabled && (!current || result.loading),
    error: current ? result.error : null,
    refresh: () => setRevision((value) => value + 1),
  }
}
