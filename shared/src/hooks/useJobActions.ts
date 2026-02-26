import { useCallback, useRef } from "react";
import type { Transport } from "../transport";

export function useJobActions(transport: Transport, onStatusChange?: () => void) {
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const delayedRefresh = useCallback(() => {
    if (onStatusChange) setTimeout(onStatusChange, 500);
  }, [onStatusChange]);

  const runJob = useCallback(
    async (name: string, params?: Record<string, string>) => {
      await transportRef.current.runJob(name, params);
      delayedRefresh();
    },
    [delayedRefresh],
  );

  const stopJob = useCallback(
    async (name: string) => {
      await transportRef.current.stopJob(name);
      delayedRefresh();
    },
    [delayedRefresh],
  );

  const pauseJob = useCallback(
    async (name: string) => {
      await transportRef.current.pauseJob(name);
      delayedRefresh();
    },
    [delayedRefresh],
  );

  const resumeJob = useCallback(
    async (name: string) => {
      await transportRef.current.resumeJob(name);
      delayedRefresh();
    },
    [delayedRefresh],
  );

  const toggleJob = useCallback(
    async (name: string) => {
      await transportRef.current.toggleJob(name);
      delayedRefresh();
    },
    [delayedRefresh],
  );

  const deleteJob = useCallback(
    async (name: string) => {
      await transportRef.current.deleteJob(name);
      delayedRefresh();
    },
    [delayedRefresh],
  );

  const restartJob = useCallback(
    async (name: string, params?: Record<string, string>) => {
      if (transportRef.current.restartJob) {
        await transportRef.current.restartJob(name, params);
      } else {
        await transportRef.current.runJob(name, params);
      }
      delayedRefresh();
    },
    [delayedRefresh],
  );

  const sendInput = useCallback(async (name: string, text: string) => {
    await transportRef.current.sendInput(name, text);
  }, []);

  const runAgent = useCallback(
    async (prompt: string) => {
      await transportRef.current.runAgent(prompt);
      delayedRefresh();
    },
    [delayedRefresh],
  );

  return {
    runJob,
    stopJob,
    pauseJob,
    resumeJob,
    toggleJob,
    deleteJob,
    restartJob,
    sendInput,
    runAgent,
  };
}
