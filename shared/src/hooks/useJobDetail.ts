import { useCallback, useEffect, useRef, useState } from "react";
import type { Transport } from "../transport";
import type { RunRecord } from "../types/job";

export function useJobDetail(transport: Transport, jobName: string) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const loadRuns = useCallback(async () => {
    try {
      const loaded = await transportRef.current.getRunHistory(jobName);
      setRuns(loaded);
    } catch (e) {
      console.error("Failed to load runs:", e);
    }
  }, [jobName]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  return { runs, reloadRuns: loadRuns };
}
