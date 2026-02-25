import { useEffect, useRef, useCallback } from "react";
import { AppState as RNAppState, Platform } from "react-native";
import { getWsUrl, getSubscriptionStatus } from "../api/client";
import { useAuthStore } from "../store/auth";
import { useJobsStore } from "../store/jobs";
import { useWsStore } from "../store/ws";
import { dispatchLogChunk } from "./useLogs";
import { resolveRequest } from "../lib/useRequestMap";
import type { ClientMessage, IncomingMessage } from "../types/messages";

let globalWs: WebSocket | null = null;
let globalSend: ((msg: ClientMessage) => void) | null = null;

export function getWsSend() {
  return globalSend;
}

let msgIdCounter = 0;
export function nextId(): string {
  return `m_${++msgIdCounter}_${Date.now()}`;
}

export function useWebSocket() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const setConnected = useWsStore((s) => s.setConnected);
  const setSubscriptionRequired = useWsStore((s) => s.setSubscriptionRequired);
  const setDesktopStatus = useWsStore((s) => s.setDesktopStatus);
  const resetWs = useWsStore((s) => s.reset);
  const setJobs = useJobsStore((s) => s.setJobs);
  const updateStatus = useJobsStore((s) => s.updateStatus);

  const backoffRef = useRef(1000);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;

  // Use ref to break circular dependency between connect and scheduleReconnect
  const connectRef = useRef<() => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(() => {
      if (mountedRef.current && isAuthenticatedRef.current) {
        connectRef.current();
      }
    }, backoffRef.current);
    backoffRef.current = Math.min(backoffRef.current * 2, 30000);
  }, []);

  const doConnect = useCallback(async () => {
    if (globalWs && globalWs.readyState <= WebSocket.OPEN) return;

    // Check subscription before attempting WS connection
    try {
      const sub = await getSubscriptionStatus();
      if (!sub.subscribed) {
        console.log("[ws] subscription required, skipping WS connect");
        setSubscriptionRequired(true);
        return;
      }
    } catch (e) {
      console.log("[ws] subscription check failed, proceeding:", e);
    }

    let url: string;
    try {
      url = await getWsUrl();
    } catch (e) {
      console.log("[ws] failed to get URL:", e);
      return;
    }

    console.log("[ws] connecting to:", url.replace(/token=.*/, "token=***"));
    const ws = new WebSocket(url);
    globalWs = ws;

    ws.onopen = () => {
      console.log("[ws] connected");
      if (!mountedRef.current) return;
      setConnected(true);
      setSubscriptionRequired(false);
      backoffRef.current = 1000;

      const id = nextId();
      ws.send(JSON.stringify({ type: "list_jobs", id }));
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      let msg: IncomingMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "welcome":
          break;
        case "jobs_list":
        case "jobs_changed":
          setJobs(msg.jobs, msg.statuses);
          // These messages are forwarded from desktop, so desktop is online
          useWsStore.getState().desktopOnline || useWsStore.setState({ desktopOnline: true });
          break;
        case "status_update":
          updateStatus(msg.name, msg.status);
          useWsStore.getState().desktopOnline || useWsStore.setState({ desktopOnline: true });
          break;
        case "log_chunk":
          dispatchLogChunk(msg.name, msg.content);
          break;
        case "desktop_status":
          setDesktopStatus(msg.device_id, msg.device_name, msg.online);
          break;
        case "run_history":
          resolveRequest(msg.id, msg.runs);
          break;
        case "error":
          if (msg.code === "UNAUTHORIZED") {
            refreshToken().then((ok) => {
              if (ok) scheduleReconnect();
            });
          }
          break;
        default:
          // Try resolving as a pending request (ack messages etc.)
          if ("id" in msg && msg.id) {
            resolveRequest(msg.id, msg);
          }
          break;
      }
    };

    ws.onclose = (e) => {
      console.log("[ws] closed, code:", e.code, "reason:", e.reason);
      globalWs = null;
      globalSend = null;
      if (!mountedRef.current) return;
      setConnected(false);

      if (e.reason?.includes("403")) {
        setSubscriptionRequired(true);
        return; // don't reconnect
      }

      if (e.reason?.includes("401")) {
        refreshToken().then((ok) => {
          if (ok) {
            backoffRef.current = 1000;
            scheduleReconnect();
          } else {
            useAuthStore.getState().logout();
          }
        });
        return;
      }

      // On web, a rejected WS upgrade (403/401) shows as code 1006 with empty reason.
      // Check subscription status via HTTP to determine the cause.
      if (Platform.OS === "web" && e.code === 1006 && !e.reason) {
        getSubscriptionStatus()
          .then((sub) => {
            if (!mountedRef.current) return;
            if (!sub.subscribed) {
              setSubscriptionRequired(true);
            } else {
              scheduleReconnect();
            }
          })
          .catch(() => {
            if (!mountedRef.current) return;
            // HTTP request also failed - try token refresh then reconnect
            refreshToken().then((ok) => {
              if (ok) {
                backoffRef.current = 1000;
                scheduleReconnect();
              } else {
                useAuthStore.getState().logout();
              }
            });
          });
        return;
      }

      scheduleReconnect();
    };

    ws.onerror = (e) => {
      console.log("[ws] error:", e.message || e);
    };

    globalSend = (msg: ClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };
  }, [setConnected, setSubscriptionRequired, setDesktopStatus, setJobs, updateStatus, refreshToken, scheduleReconnect]);

  // Keep ref in sync
  connectRef.current = doConnect;

  useEffect(() => {
    mountedRef.current = true;
    if (isAuthenticated) {
      doConnect();
    }

    const sub = RNAppState.addEventListener("change", (state) => {
      if (state === "active" && isAuthenticatedRef.current) {
        if (!globalWs || globalWs.readyState !== WebSocket.OPEN) {
          backoffRef.current = 1000;
          connectRef.current();
        }
      }
    });

    return () => {
      mountedRef.current = false;
      sub.remove();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (globalWs) {
        globalWs.close();
        globalWs = null;
        globalSend = null;
      }
      resetWs();
    };
  }, [isAuthenticated, doConnect, resetWs]);

  const send = useCallback((msg: ClientMessage) => {
    if (globalSend) globalSend(msg);
  }, []);

  return { send };
}
