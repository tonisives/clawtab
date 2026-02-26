import type { Transport } from "@clawtab/shared";
import type { RemoteJob, JobStatus, RunRecord, RunDetail } from "@clawtab/shared";
import type { ClaudeProcess } from "@clawtab/shared";
import { getWsSend, nextId } from "../hooks/useWebSocket";
import { registerRequest } from "../lib/useRequestMap";
import { useJobsStore } from "../store/jobs";
import { dispatchLogChunk } from "../hooks/useLogs";

function send(msg: Record<string, unknown>): void {
  const ws = getWsSend();
  if (ws) ws(msg as never);
}

export function createWsTransport(): Transport {
  return {
    async listJobs() {
      const id = nextId();
      send({ type: "list_jobs", id });
      const result = await registerRequest<{
        jobs: RemoteJob[];
        statuses: Record<string, JobStatus>;
      }>(id);
      return result;
    },

    async getStatuses() {
      // Remote gets statuses reactively via WS; return current store state
      return useJobsStore.getState().statuses;
    },

    async runJob(name: string, params?: Record<string, string>) {
      const id = nextId();
      send({ type: "run_job", id, name, params });
    },

    async stopJob(name: string) {
      const id = nextId();
      send({ type: "stop_job", id, name });
    },

    async pauseJob(name: string) {
      const id = nextId();
      send({ type: "pause_job", id, name });
    },

    async resumeJob(name: string) {
      const id = nextId();
      send({ type: "resume_job", id, name });
    },

    async toggleJob(_name: string) {
      // Remote doesn't support toggle yet - no-op
    },

    async deleteJob(_name: string) {
      // Remote doesn't support delete yet - no-op
    },

    async getRunHistory(name: string) {
      const id = nextId();
      send({ type: "get_run_history", id, name, limit: 50 });
      return registerRequest<RunRecord[]>(id);
    },

    async getRunDetail(runId: string) {
      const id = nextId();
      send({ type: "get_run_detail", id, run_id: runId });
      const result = await registerRequest<{ detail?: RunDetail }>(id);
      return result.detail ?? null;
    },

    async detectProcesses() {
      return useJobsStore.getState().detectedProcesses;
    },

    async sendInput(name: string, text: string) {
      const id = nextId();
      send({ type: "send_input", id, name, text });
    },

    subscribeLogs(name: string, onChunk: (content: string) => void) {
      const id = nextId();
      send({ type: "subscribe_logs", id, name });

      // Listen to log dispatches
      const handler = (jobName: string, content: string) => {
        if (jobName === name) onChunk(content);
      };

      // Register a listener on the global dispatch
      const _origDispatch = dispatchLogChunk;
      // We'll use the existing useLogs hook pattern instead - return unsub
      // The remote already handles log_chunk in WS handler -> dispatchLogChunk
      // So we piggyback on that global buffer

      // For shared transport, we hook into the existing log system
      const listeners = _getLogListeners(name);
      listeners.add(onChunk);

      return () => {
        listeners.delete(onChunk);
        if (listeners.size === 0) {
          send({ type: "unsubscribe_logs", name });
        }
      };
    },

    async runAgent(prompt: string) {
      const id = nextId();
      send({ type: "run_agent", id, prompt });
    },
  };
}

// Internal log listener registry for the transport layer
const logListenerMap = new Map<string, Set<(content: string) => void>>();

function _getLogListeners(name: string): Set<(content: string) => void> {
  if (!logListenerMap.has(name)) {
    logListenerMap.set(name, new Set());
  }
  return logListenerMap.get(name)!;
}

// Called from the WS message handler to dispatch to transport subscribers
export function dispatchTransportLogChunk(name: string, content: string) {
  const listeners = logListenerMap.get(name);
  if (listeners) {
    for (const fn of listeners) fn(content);
  }
}
