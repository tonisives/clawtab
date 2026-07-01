import { useEffect, useRef, useCallback, useState } from "react";
import { getWsSend, nextId } from "../lib/wsRuntime";
import { clearRequest, registerRequest } from "../lib/useRequestMap";
import type { XtermLogHandle } from "@clawtab/shared";

// Global PTY event listeners keyed by pane_id
const ptyListeners = new Map<string, Set<(data: string) => void>>();
const ptyExitListeners = new Map<string, Set<() => void>>();
type PtySubscription = {
  count: number;
  tmuxSession: string;
  getDimensions: () => { cols: number; rows: number };
  state: PtyConnectionState;
  error?: string;
  stateListeners: Set<(state: PtyConnectionState, error?: string) => void>;
  pendingAckId?: string;
  ackTimer?: ReturnType<typeof setTimeout>;
  subscribeTimer?: ReturnType<typeof setTimeout>;
  unsubscribeTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  startedAt: number;
  retryAttempt: number;
  released: boolean;
};

const ptySubscriptions = new Map<string, PtySubscription>();

type PtyConnectionState = "idle" | "connecting" | "failed";

const SUBSCRIBE_ACK_TIMEOUT_MS = 15000;
const SUBSCRIBE_RETRY_WINDOW_MS = 45000;
const SUBSCRIBE_RETRY_BASE_MS = 700;
const SUBSCRIBE_RETRY_MAX_MS = 3000;
const DEFAULT_DIMS = { cols: 80, rows: 24 };
const TERMINAL_RESET_B64 = "G2M=";

function setSubscriptionState(
  subscription: PtySubscription,
  state: PtyConnectionState,
  error?: string,
) {
  subscription.state = state;
  subscription.error = error;
  for (const fn of subscription.stateListeners) fn(state, error);
}

function clearSubscribeWait(subscription: PtySubscription) {
  if (subscription.pendingAckId) {
    clearRequest(subscription.pendingAckId);
    subscription.pendingAckId = undefined;
  }
  if (subscription.ackTimer) {
    clearTimeout(subscription.ackTimer);
    subscription.ackTimer = undefined;
  }
}

function clearSubscribeRetry(subscription: PtySubscription) {
  if (subscription.retryTimer) {
    clearTimeout(subscription.retryTimer);
    subscription.retryTimer = undefined;
  }
}

function scheduleSubscribeRetry(
  paneId: string,
  subscription: PtySubscription,
  finalError: string,
) {
  clearSubscribeWait(subscription);
  const elapsed = Date.now() - subscription.startedAt;
  if (elapsed >= SUBSCRIBE_RETRY_WINDOW_MS || subscription.count <= 0) {
    clearSubscribeRetry(subscription);
    setSubscriptionState(subscription, "failed", finalError);
    return;
  }

  const delay = Math.min(
    SUBSCRIBE_RETRY_MAX_MS,
    SUBSCRIBE_RETRY_BASE_MS * Math.max(1, subscription.retryAttempt),
  );
  subscription.retryAttempt += 1;
  setSubscriptionState(subscription, "connecting");
  clearSubscribeRetry(subscription);
  subscription.retryTimer = setTimeout(() => {
    subscription.retryTimer = undefined;
    sendSubscribe(paneId, subscription);
  }, delay);
}

function sendSubscribe(paneId: string, subscription: PtySubscription) {
  const send = getWsSend();
  if (!send) return false;
  const dims = subscription.getDimensions();
  const id = nextId();

  clearSubscribeWait(subscription);
  clearSubscribeRetry(subscription);
  setSubscriptionState(subscription, "connecting");
  subscription.released = false;

  const ackPromise = registerRequest<{ success?: boolean; error?: string; code?: string; message?: string }>(id);
  send({
    type: "subscribe_pty",
    id,
    pane_id: paneId,
    tmux_session: subscription.tmuxSession,
    cols: dims.cols,
    rows: dims.rows,
  });
  subscription.pendingAckId = id;
  subscription.ackTimer = setTimeout(() => {
    subscription.ackTimer = undefined;
    if (subscription.state === "connecting") {
      subscription.pendingAckId = undefined;
      clearRequest(id);
      scheduleSubscribeRetry(paneId, subscription, "Terminal connection timed out.");
    }
  }, SUBSCRIBE_ACK_TIMEOUT_MS);
  ackPromise.then((ack) => {
    if (subscription.pendingAckId !== id) return;
    subscription.pendingAckId = undefined;
    if (ack?.success === false || ack?.code) {
      if (subscription.ackTimer) clearTimeout(subscription.ackTimer);
      subscription.ackTimer = undefined;
      scheduleSubscribeRetry(
        paneId,
        subscription,
        ack.error ?? ack.message ?? "Terminal connection failed.",
      );
      return;
    }
    if (subscription.ackTimer) clearTimeout(subscription.ackTimer);
    subscription.ackTimer = undefined;
    clearSubscribeRetry(subscription);
    subscription.retryAttempt = 0;
    subscription.startedAt = Date.now();
    setSubscriptionState(subscription, "idle");
  });
  return true;
}

export function replayActivePtySubscriptions(mode: "connect" | "resume" = "connect") {
  for (const [paneId, subscription] of ptySubscriptions) {
    if (subscription.count <= 0) continue;
    if (mode === "resume" && !subscription.released) continue;
    if (subscription.subscribeTimer) clearTimeout(subscription.subscribeTimer);
    subscription.subscribeTimer = undefined;
    if (subscription.unsubscribeTimer) clearTimeout(subscription.unsubscribeTimer);
    subscription.unsubscribeTimer = undefined;
    subscription.startedAt = Date.now();
    subscription.retryAttempt = 0;
    sendSubscribe(paneId, subscription);
  }
}

export function releaseActivePtySubscriptions() {
  const send = getWsSend();
  if (!send) return;
  for (const [paneId, subscription] of ptySubscriptions) {
    if (subscription.count <= 0) continue;
    if (subscription.subscribeTimer) clearTimeout(subscription.subscribeTimer);
    subscription.subscribeTimer = undefined;
    if (subscription.unsubscribeTimer) clearTimeout(subscription.unsubscribeTimer);
    subscription.unsubscribeTimer = undefined;
    clearSubscribeRetry(subscription);
    send({ type: "unsubscribe_pty", pane_id: paneId });
    subscription.released = true;
  }
}

function isTerminalReset(data: string) {
  return data === TERMINAL_RESET_B64;
}

/** Called from useWebSocket when a pty_output message arrives */
export function dispatchPtyOutput(paneId: string, data: string) {
  const subscription = ptySubscriptions.get(paneId);
  if (subscription) {
    clearSubscribeWait(subscription);
    clearSubscribeRetry(subscription);
    subscription.retryAttempt = 0;
    subscription.startedAt = Date.now();
    setSubscriptionState(subscription, "idle");
  }
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
  const [error, setError] = useState<string | undefined>(undefined);
  const [hasOutput, setHasOutput] = useState(false);
  const gotDataRef = useRef(false);
  const tmuxSessionRef = useRef(tmuxSession);
  const pendingOutputRef = useRef<string[]>([]);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flushPendingOutput = useCallback(() => {
    const term = termRef.current;
    if (!term || pendingOutputRef.current.length === 0) return false;
    for (const data of pendingOutputRef.current) {
      if (isTerminalReset(data)) {
        term.clear();
      } else {
        term.write(data);
      }
    }
    pendingOutputRef.current = [];
    return true;
  }, [termRef]);

  useEffect(() => {
    if (tmuxSession) tmuxSessionRef.current = tmuxSession;
  }, [tmuxSession]);

  // Subscribe to PTY stream
  useEffect(() => {
    const send = getWsSend();
    const activeTmuxSession = tmuxSessionRef.current;
    if (!paneId || !activeTmuxSession) return;

    gotDataRef.current = false;
    pendingOutputRef.current = [];
    setError(undefined);
    let stateListener: ((state: PtyConnectionState, error?: string) => void) | undefined;

    const onOutput = (data: string) => {
      if (!gotDataRef.current) {
        gotDataRef.current = true;
        setHasOutput(true);
        setConnecting(false);
        setError(undefined);
      }
      if (termRef.current) {
        flushPendingOutput();
        if (isTerminalReset(data)) {
          termRef.current.clear();
          return;
        }
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

    const getDimensions = () => termRef.current?.dimensions() ?? DEFAULT_DIMS;
    const existing = ptySubscriptions.get(paneId);
    if (existing) {
      if (existing.unsubscribeTimer) clearTimeout(existing.unsubscribeTimer);
      existing.unsubscribeTimer = undefined;
      existing.count += 1;
      existing.getDimensions = getDimensions;
      subscribedRef.current = true;
      stateListener = (state: PtyConnectionState, message?: string) => {
        const waitingForFirstOutput = state === "connecting" && !gotDataRef.current;
        if (waitingForFirstOutput) {
          gotDataRef.current = false;
          setHasOutput(false);
        }
        setConnecting(waitingForFirstOutput);
        setError(state === "failed" ? message ?? "Terminal connection failed." : undefined);
      };
      existing.stateListeners.add(stateListener);
      stateListener(existing.state, existing.error);
    } else {
      stateListener = (state: PtyConnectionState, message?: string) => {
        const waitingForFirstOutput = state === "connecting" && !gotDataRef.current;
        if (waitingForFirstOutput) {
          gotDataRef.current = false;
          setHasOutput(false);
        }
        setConnecting(waitingForFirstOutput);
        setError(state === "failed" ? message ?? "Terminal connection failed." : undefined);
      };
      const subscription: PtySubscription = {
        count: 1,
        tmuxSession: activeTmuxSession,
        getDimensions,
        state: "connecting",
        stateListeners: new Set([stateListener]),
        startedAt: Date.now(),
        retryAttempt: 0,
        released: false,
      };
      ptySubscriptions.set(paneId, subscription);
      subscribedRef.current = true;
      stateListener("connecting");
      if (send) {
        sendSubscribe(paneId, subscription);
      }
    }

    const flushInterval = setInterval(flushPendingOutput, 50);

    return () => {
      const activeSubscription = ptySubscriptions.get(paneId);
      clearInterval(flushInterval);
      ptyListeners.get(paneId)?.delete(onOutput);
      ptyExitListeners.get(paneId)?.delete(onExit);
      if (stateListener) activeSubscription?.stateListeners.delete(stateListener);
      if (subscribedRef.current) {
        const subscription = ptySubscriptions.get(paneId);
        if (subscription) {
          subscription.count -= 1;
          if (subscription.count <= 0) {
            subscription.unsubscribeTimer = setTimeout(() => {
              const current = ptySubscriptions.get(paneId);
              if (!current || current.count > 0) return;
              clearSubscribeWait(current);
              clearSubscribeRetry(current);
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
      lastResizeRef.current = null;
      pendingOutputRef.current = [];
      setConnecting(false);
      setError(undefined);
    };
  }, [paneId, !!tmuxSession, flushPendingOutput]);

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

  return { sendInput, sendResize, connecting, error, hasOutput };
}
