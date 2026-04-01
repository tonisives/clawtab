import { useEffect, useRef, useCallback } from "react";
import { getWsSend, nextId } from "./useWebSocket";
import type { XtermLogHandle } from "@clawtab/shared";

// Global PTY event listeners keyed by pane_id
const ptyListeners = new Map<string, Set<(data: string) => void>>();
const ptyExitListeners = new Map<string, Set<() => void>>();

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

  // Subscribe to PTY stream
  useEffect(() => {
    const send = getWsSend();
    if (!send || !paneId || !tmuxSession) return;

    const onOutput = (data: string) => {
      termRef.current?.write(data);
    };

    const onExit = () => {
      // Could notify parent component
    };

    // Register listeners
    if (!ptyListeners.has(paneId)) ptyListeners.set(paneId, new Set());
    ptyListeners.get(paneId)!.add(onOutput);
    if (!ptyExitListeners.has(paneId)) ptyExitListeners.set(paneId, new Set());
    ptyExitListeners.get(paneId)!.add(onExit);

    // Get initial dimensions from terminal
    const dims = termRef.current?.dimensions() ?? { cols: 80, rows: 24 };

    send({
      type: "subscribe_pty",
      id: nextId(),
      pane_id: paneId,
      tmux_session: tmuxSession,
      cols: dims.cols,
      rows: dims.rows,
    });
    subscribedRef.current = true;

    return () => {
      ptyListeners.get(paneId)?.delete(onOutput);
      ptyExitListeners.get(paneId)?.delete(onExit);
      if (subscribedRef.current) {
        const s = getWsSend();
        if (s) s({ type: "unsubscribe_pty", pane_id: paneId });
        subscribedRef.current = false;
      }
    };
  }, [paneId, tmuxSession]);

  const sendInput = useCallback(
    (b64: string) => {
      const send = getWsSend();
      if (send) send({ type: "pty_input", pane_id: paneId, data: b64 });
    },
    [paneId],
  );

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      const send = getWsSend();
      if (send) send({ type: "pty_resize", pane_id: paneId, cols, rows });
    },
    [paneId],
  );

  return { sendInput, sendResize };
}
