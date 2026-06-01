import { useEffect, useRef, useCallback, useState } from "react";
import { getWsSend, nextId } from "../lib/wsRuntime";
import type { XtermLogHandle } from "@clawtab/shared";

// Global PTY event listeners keyed by pane_id
const ptyListeners = new Map<string, Set<(data: string) => void>>();
const ptyExitListeners = new Map<string, Set<() => void>>();
const ptySubscriptions = new Map<string, {
  count: number;
  tmuxSession: string;
  unsubscribeTimer?: ReturnType<typeof setTimeout>;
}>();

const CONNECTING_FALLBACK_MS = 15000;

/** Called from useWebSocket when a pty_output message arrives */
export function dispatchPtyOutput(paneId: string, data: string) {
  const listeners = ptyListeners.get(paneId);
  if (listeners) {
    for (const fn of listeners) fn(data);
  }
}

/** Called from useWebSocket when a pty_exit message arrives */
export function dispatchPtyExit(paneId: string) {
  const listeners = ptyExitListeners.get(paneId);
  if (listeners) {
    for (const fn of listeners) fn();
  }
}

/**
 * Hook that manages a PTY subscription for a tmux pane.
 * Subscribes on mount, forwards output to the XtermLog ref,
 * sends input/resize back through the relay.
 */
export function usePty(
  paneId: string,
  tmuxSession: string,
  termRef: React.RefObject<XtermLogHandle | null>,
) {
  const subscribedRef = useRef(false);
  const [connecting, setConnecting] = useState(false);
  const gotDataRef = useRef(false);
  const pendingOutputRef = useRef<string[]>([]);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const connectingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flushPendingOutput = useCallback(() => {
    const term = termRef.current;
    if (!term || pendingOutputRef.current.length === 0) return false;
    for (const data of pendingOutputRef.current) term.write(data);
    pendingOutputRef.current = [];
    return true;
  }, [termRef]);

  // Subscribe to PTY stream
  useEffect(() => {
    const send = getWsSend();
    if (!paneId || !tmuxSession) return;
    let subscribeStartTimer: ReturnType<typeof setTimeout> | undefined;

    gotDataRef.current = false;
    pendingOutputRef.current = [];

    const onOutput = (data: string) => {
      if (!gotDataRef.current) {
        gotDataRef.current = true;
        if (connectingTimerRef.current) clearTimeout(connectingTimerRef.current);
        connectingTimerRef.current = undefined;
        setConnecting(false);
      }
      if (termRef.current) {
        flushPendingOutput();
        termRef.current.write(data);
      } else {
        pendingOutputRef.current.push(data);
      }
    };

    const onExit = () => {
      // Could notify parent component
    };

    // Register listeners
    if (!ptyListeners.has(paneId)) ptyListeners.set(paneId, new Set());
    ptyListeners.get(paneId)!.add(onOutput);
    if (!ptyExitListeners.has(paneId)) ptyExitListeners.set(paneId, new Set());
    ptyExitListeners.get(paneId)!.add(onExit);

    const existing = ptySubscriptions.get(paneId);
    if (existing && existing.tmuxSession === tmuxSession) {
      if (existing.unsubscribeTimer) clearTimeout(existing.unsubscribeTimer);
      existing.unsubscribeTimer = undefined;
      existing.count += 1;
      subscribedRef.current = true;
      setConnecting(false);
    } else {
      if (existing?.unsubscribeTimer) clearTimeout(existing.unsubscribeTimer);
      if (send) {
        setConnecting(true);
        connectingTimerRef.current = setTimeout(() => {
          connectingTimerRef.current = undefined;
          setConnecting(false);
        }, CONNECTING_FALLBACK_MS);
        subscribeStartTimer = setTimeout(() => {
          const currentSend = getWsSend();
          if (!currentSend) return;
          // Get initial dimensions from terminal
          const dims = termRef.current?.dimensions() ?? { cols: 80, rows: 24 };

          currentSend({
            type: "subscribe_pty",
            id: nextId(),
            pane_id: paneId,
            tmux_session: tmuxSession,
            cols: dims.cols,
            rows: dims.rows,
          });
          ptySubscriptions.set(paneId, { count: 1, tmuxSession });
          subscribedRef.current = true;
        }, 120);
      }
    }

    const flushInterval = setInterval(flushPendingOutput, 50);

    return () => {
      if (subscribeStartTimer) clearTimeout(subscribeStartTimer);
      clearInterval(flushInterval);
      ptyListeners.get(paneId)?.delete(onOutput);
      ptyExitListeners.get(paneId)?.delete(onExit);
      if (subscribedRef.current) {
        const subscription = ptySubscriptions.get(paneId);
        if (subscription) {
          subscription.count -= 1;
          if (subscription.count <= 0) {
            subscription.unsubscribeTimer = setTimeout(() => {
              const current = ptySubscriptions.get(paneId);
              if (!current || current.count > 0) return;
              const s = getWsSend();
              if (s) s({ type: "unsubscribe_pty", pane_id: paneId });
              ptySubscriptions.delete(paneId);
            }, 1200);
          }
        }
        subscribedRef.current = false;
      }
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = undefined;
      if (connectingTimerRef.current) clearTimeout(connectingTimerRef.current);
      connectingTimerRef.current = undefined;
      lastResizeRef.current = null;
      pendingOutputRef.current = [];
      setConnecting(false);
    };
  }, [paneId, tmuxSession, flushPendingOutput]);

  const sendInput = useCallback(
    (b64: string) => {
      const send = getWsSend();
      if (send) send({ type: "pty_input", pane_id: paneId, data: b64 });
    },
    [paneId],
  );

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      if (cols <= 0 || rows <= 0) return;
      const last = lastResizeRef.current;
      if (last?.cols === cols && last?.rows === rows) return;
      lastResizeRef.current = { cols, rows };
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = undefined;
        const latest = lastResizeRef.current;
        if (!latest) return;
        const send = getWsSend();
        if (send) {
          send({
            type: "pty_resize",
            pane_id: paneId,
            cols: latest.cols,
            rows: latest.rows,
          });
        }
      }, 120);
    },
    [paneId],
  );

  return { sendInput, sendResize, connecting };
}
