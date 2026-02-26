import { useCallback, useEffect, useRef, useState } from "react";
import type { Transport } from "../transport";
import type { RemoteJob, JobStatus } from "../types/job";
import type { ClaudeProcess } from "../types/process";
import { groupJobs, sortGroupNames } from "../util/jobs";

const IDLE_STATUS: JobStatus = { state: "idle" };

export function useJobsCore(transport: Transport, pollInterval = 5000) {
  const [jobs, setJobs] = useState<RemoteJob[]>([]);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({});
  const [processes, setProcesses] = useState<ClaudeProcess[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const loadAll = useCallback(async () => {
    try {
      const result = await transportRef.current.listJobs();
      setJobs(result.jobs);
      setStatuses(result.statuses);
      setLoaded(true);
    } catch (e) {
      console.error("Failed to load jobs:", e);
    }
  }, []);

  const loadStatuses = useCallback(async () => {
    try {
      const s = await transportRef.current.getStatuses();
      setStatuses(s);
    } catch (e) {
      console.error("Failed to load statuses:", e);
    }
  }, []);

  const loadProcesses = useCallback(async () => {
    try {
      const p = await transportRef.current.detectProcesses();
      setProcesses(p);
    } catch (e) {
      console.error("Failed to detect processes:", e);
    }
  }, []);

  useEffect(() => {
    loadAll();
    loadProcesses();
    const interval = setInterval(() => {
      loadStatuses();
      loadProcesses();
    }, pollInterval);
    return () => clearInterval(interval);
  }, [loadAll, loadStatuses, loadProcesses, pollInterval]);

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const getGrouped = useCallback(
    (groupOrder: string[]) => {
      const grouped = groupJobs(jobs);
      const allGroupNames = new Set(grouped.keys());
      allGroupNames.add("agent");
      const sorted = sortGroupNames(Array.from(allGroupNames), groupOrder);
      return { grouped, sortedGroups: sorted };
    },
    [jobs],
  );

  const getStatus = useCallback(
    (name: string): JobStatus => statuses[name] ?? IDLE_STATUS,
    [statuses],
  );

  const updateStatus = useCallback((name: string, status: JobStatus) => {
    setStatuses((prev) => ({ ...prev, [name]: status }));
  }, []);

  return {
    jobs,
    statuses,
    processes,
    loaded,
    collapsedGroups,
    toggleGroup,
    getGrouped,
    getStatus,
    updateStatus,
    setJobs,
    setStatuses,
    reload: loadAll,
    reloadStatuses: loadStatuses,
  };
}
