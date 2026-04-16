import { useCallback, useEffect, useRef, useState } from "react";
import type { Transport } from "../transport";
import type { RemoteJob, JobStatus } from "../types/job";
import type { DetectedProcess } from "../types/process";
import { groupJobs, sortGroupNames } from "../util/jobs";

const IDLE_STATUS: JobStatus = { state: "idle" };
const LOCAL_CACHE_JOBS_KEY = "clawtab_desktop_cached_jobs";
const LOCAL_CACHE_STATUSES_KEY = "clawtab_desktop_cached_statuses";

function readLocalCache(): { jobs: RemoteJob[]; statuses: Record<string, JobStatus> } | null {
  if (typeof window === "undefined") return null;
  try {
    const rawJobs = window.localStorage.getItem(LOCAL_CACHE_JOBS_KEY);
    if (!rawJobs) return null;
    const rawStatuses = window.localStorage.getItem(LOCAL_CACHE_STATUSES_KEY);
    return {
      jobs: JSON.parse(rawJobs) as RemoteJob[],
      statuses: rawStatuses ? JSON.parse(rawStatuses) as Record<string, JobStatus> : {},
    };
  } catch (e) {
    console.error("Failed to read local jobs cache:", e);
    return null;
  }
}

function writeLocalCache(jobs: RemoteJob[], statuses: Record<string, JobStatus>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_CACHE_JOBS_KEY, JSON.stringify(jobs));
    window.localStorage.setItem(LOCAL_CACHE_STATUSES_KEY, JSON.stringify(statuses));
  } catch (e) {
    console.error("Failed to write local jobs cache:", e);
  }
}

export function useJobsCore(transport: Transport, pollInterval = 5000) {
  const initialCacheRef = useRef<{ jobs: RemoteJob[]; statuses: Record<string, JobStatus> } | null>(readLocalCache());
  const [jobs, setJobs] = useState<RemoteJob[]>(() => initialCacheRef.current?.jobs ?? []);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>(() => initialCacheRef.current?.statuses ?? {});
  const [processes, setProcesses] = useState<DetectedProcess[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [processesLoaded, setProcessesLoaded] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const jobsRef = useRef<RemoteJob[]>(initialCacheRef.current?.jobs ?? []);
  const loadedRef = useRef(false);
  const jobsSigRef = useRef(initialCacheRef.current ? JSON.stringify(initialCacheRef.current.jobs) : "[]");
  const statusesSigRef = useRef(initialCacheRef.current ? JSON.stringify(initialCacheRef.current.statuses) : "{}");
  const processesSigRef = useRef("[]");
  const fastPollTargetsRef = useRef<Map<string, number>>(new Map());
  const fastPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const signatureForJobs = (items: RemoteJob[]) => JSON.stringify(items);
  const signatureForStatuses = (items: Record<string, JobStatus>) => JSON.stringify(items);
  const signatureForProcesses = (items: DetectedProcess[]) =>
    JSON.stringify(items.map((proc) => [
      proc.pane_id,
      proc.cwd,
      proc.version,
      proc.display_name ?? null,
      proc.pane_title ?? null,
      proc.provider,
      proc.can_fork_session,
      proc.can_send_skills,
      proc.can_inject_secrets,
      proc.tmux_session,
      proc.window_name,
      proc.matched_group,
      proc.matched_job,
      proc.log_lines,
      proc.first_query,
      proc.last_query,
      proc.session_started_at,
      proc._last_log_change ?? null,
    ]));

  const persistCache = useCallback((nextJobs: RemoteJob[], nextStatuses: Record<string, JobStatus>) => {
    writeLocalCache(nextJobs, nextStatuses);
    if (!transportRef.current.cacheJobs) return;
    void transportRef.current.cacheJobs(nextJobs, nextStatuses).catch((e) => {
      console.error("Failed to cache jobs:", e);
    });
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const result = await transportRef.current.listJobs();
      const jobsSig = signatureForJobs(result.jobs);
      if (jobsSig !== jobsSigRef.current) {
        jobsSigRef.current = jobsSig;
        jobsRef.current = result.jobs;
        setJobs(result.jobs);
      }
      const statusesSig = signatureForStatuses(result.statuses);
      if (statusesSig !== statusesSigRef.current) {
        statusesSigRef.current = statusesSig;
        setStatuses(result.statuses);
      }
      loadedRef.current = true;
      setLoaded(true);
      persistCache(result.jobs, result.statuses);
    } catch (e) {
      console.error("Failed to load jobs:", e);
    }
  }, [persistCache]);

  const loadStatuses = useCallback(async () => {
    try {
      const s = await transportRef.current.getStatuses();
      const sig = signatureForStatuses(s);
      if (sig === statusesSigRef.current) return;
      statusesSigRef.current = sig;
      setStatuses(s);
      persistCache(jobsRef.current, s);
    } catch (e) {
      console.error("Failed to load statuses:", e);
    }
  }, [persistCache]);

  const prevLogLinesRef = useRef<Map<string, string>>(new Map());
  const prevLastLogChangeRef = useRef<Map<string, number>>(new Map());

  const loadProcesses = useCallback(async () => {
    try {
      const p = await transportRef.current.detectProcesses();
      const now = Date.now();
      const prevLogs = prevLogLinesRef.current;
      const prevChanges = prevLastLogChangeRef.current;
      const nextLogs = new Map<string, string>();
      const nextChanges = new Map<string, number>();
      for (const proc of p) {
        const oldLog = prevLogs.get(proc.pane_id);
        nextLogs.set(proc.pane_id, proc.log_lines);
        if (oldLog !== undefined && oldLog !== proc.log_lines) {
          proc._last_log_change = now;
        } else {
          proc._last_log_change = prevChanges.get(proc.pane_id) ?? now;
        }
        nextChanges.set(proc.pane_id, proc._last_log_change);
      }
      prevLogLinesRef.current = nextLogs;
      prevLastLogChangeRef.current = nextChanges;
      setProcessesLoaded(true);
      const sig = signatureForProcesses(p);
      if (sig === processesSigRef.current) return;
      processesSigRef.current = sig;
      setProcesses(p);
    } catch (e) {
      console.error("Failed to detect processes:", e);
    }
  }, []);

  const stopFastPoll = useCallback(() => {
    if (!fastPollIntervalRef.current) return;
    clearInterval(fastPollIntervalRef.current);
    fastPollIntervalRef.current = null;
  }, []);

  const runFastPoll = useCallback(async () => {
    const now = Date.now();
    for (const [key, expiresAt] of fastPollTargetsRef.current) {
      if (expiresAt <= now) fastPollTargetsRef.current.delete(key);
    }
    if (fastPollTargetsRef.current.size === 0) {
      stopFastPoll();
      return;
    }
    await Promise.all([loadStatuses(), loadProcesses()]);
  }, [loadProcesses, loadStatuses, stopFastPoll]);

  const requestFastPoll = useCallback((target: string, durationMs = 7000) => {
    fastPollTargetsRef.current.set(target, Date.now() + durationMs);
    if (!fastPollIntervalRef.current) {
      fastPollIntervalRef.current = setInterval(() => {
        void runFastPoll();
      }, 500);
    }
    void runFastPoll();
  }, [runFastPoll]);

  useEffect(() => {
    let cancelled = false;
    if (!transportRef.current.getCachedJobs) return () => {
      cancelled = true;
    };
    void transportRef.current.getCachedJobs().then((cached) => {
      if (cancelled || loadedRef.current || !cached) return;
      const jobsSig = signatureForJobs(cached.jobs);
      const statusesSig = signatureForStatuses(cached.statuses);
      if (jobsSigRef.current !== "[]" || statusesSigRef.current !== "{}") return;
      jobsSigRef.current = jobsSig;
      statusesSigRef.current = statusesSig;
      jobsRef.current = cached.jobs;
      setJobs(cached.jobs);
      setStatuses(cached.statuses);
    }).catch((e) => {
      console.error("Failed to load cached jobs:", e);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    loadAll();
    loadProcesses();
    const interval = setInterval(() => {
      loadStatuses();
      loadProcesses();
    }, pollInterval);
    return () => {
      clearInterval(interval);
      stopFastPoll();
    };
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
    processesLoaded,
    collapsedGroups,
    toggleGroup,
    getGrouped,
    getStatus,
    updateStatus,
    setJobs,
    setStatuses,
    setProcesses,
    reload: loadAll,
    reloadStatuses: loadStatuses,
    reloadProcesses: loadProcesses,
    requestFastPoll,
  };
}
