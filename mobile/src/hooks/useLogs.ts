import { useEffect, useRef, useState, useCallback } from "react";
import { getWsSend, nextId } from "./useWebSocket";

// Global log buffer per job - survives component remounts
const logBuffers = new Map<string, string>();
const logListeners = new Map<string, Set<(content: string) => void>>();

// Called from the WebSocket message handler
export function dispatchLogChunk(name: string, content: string) {
  const existing = logBuffers.get(name) || "";
  logBuffers.set(name, existing + content);
  const listeners = logListeners.get(name);
  if (listeners) {
    const full = logBuffers.get(name)!;
    for (const fn of listeners) fn(full);
  }
}

export function useLogs(jobName: string) {
  const [logs, setLogs] = useState(() => logBuffers.get(jobName) || "");
  const subscribedRef = useRef(false);

  useEffect(() => {
    // Register listener
    if (!logListeners.has(jobName)) {
      logListeners.set(jobName, new Set());
    }
    const listeners = logListeners.get(jobName)!;
    listeners.add(setLogs);

    // Subscribe via WebSocket
    const send = getWsSend();
    if (send && !subscribedRef.current) {
      send({ type: "subscribe_logs", id: nextId(), name: jobName });
      subscribedRef.current = true;
    }

    return () => {
      listeners.delete(setLogs);
      if (listeners.size === 0) {
        const send = getWsSend();
        if (send) {
          send({ type: "unsubscribe_logs", name: jobName });
        }
        subscribedRef.current = false;
      }
    };
  }, [jobName]);

  const clearLogs = useCallback(() => {
    logBuffers.set(jobName, "");
    setLogs("");
  }, [jobName]);

  return { logs, clearLogs };
}
