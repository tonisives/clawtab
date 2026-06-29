import { useEffect, useRef, useCallback } from "react";
import { AppState as RNAppState, Platform } from "react-native";
import { getWsUrl, getSubscriptionStatus } from "../api/client";
import { useAuthStore } from "../store/auth";
import { useJobsStore } from "../store/jobs";
import { useNotificationStore } from "../store/notifications";
import { useWsStore } from "../store/ws";
import { getPushToken } from "../lib/notifications";
import { dispatchLogChunk } from "./useLogs";
import { dispatchPtyOutput, dispatchPtyExit, replayActivePtySubscriptions, releaseActivePtySubscriptions } from "./usePty";
import { dispatchTransportLogChunk } from "../transport/wsTransport";
import { resolveRequest } from "../lib/useRequestMap";
import { saveJobsCache, saveQuestionsCache } from "../lib/jobCache";
import { flushPendingAnswers, clearRegisteredSend } from "../lib/pendingAnswers";
import type { ClientMessage, IncomingMessage } from "../types/messages";
import { getWs, getWsSend, nextId, setWs, setWsSend } from "../lib/wsRuntime";

export function useWebSocket() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const setConnected = useWsStore((s) => s.setConnected);
  const setDesktopStatus = useWsStore((s) => s.setDesktopStatus);
  const resetWs = useWsStore((s) => s.reset);
  const setJobs = useJobsStore((s) => s.setJobs);
  const updateStatus = useJobsStore((s) => s.updateStatus);

  const backoffRef = useRef(1000);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);
  const isAuthenticatedRef = useRef(isAuthenticated);
  const appStateRef = useRef(RNAppState.currentState);
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
    const existingWs = getWs();
    if (existingWs && existingWs.readyState <= WebSocket.OPEN) return;

    let url: string;
    try {
      url = await getWsUrl();
    } catch (e) {
      console.log("[ws] failed to get URL:", e);
      return;
    }

    console.log("[ws] connecting to:", url.replace(/token=.*/, "token=***"));
    const ws = new WebSocket(url);
    setWs(ws);

    ws.onopen = () => {
      console.log("[ws] connected");
      if (!mountedRef.current) return;
      setConnected(true);
      backoffRef.current = 1000;

      ws.send(JSON.stringify({ type: "list_jobs", id: nextId() }));
      ws.send(JSON.stringify({ type: "get_settings", id: nextId() }));
      replayActivePtySubscriptions();

      // Flush any answers queued while offline
      flushPendingAnswers((msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      });

      // Register push token
      getPushToken().then((token) => {
        if (token && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "register_push_token",
            id: nextId(),
            push_token: token,
            platform: Platform.OS === "ios" ? "ios" : "android",
          }));
        }
      });
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
          saveJobsCache(msg.jobs, msg.statuses);
          // These messages are forwarded from desktop, so desktop is online
          useWsStore.getState().desktopOnline || useWsStore.setState({ desktopOnline: true });
          break;
        case "status_update":
          updateStatus(msg.name, msg.status);
          { const s = useJobsStore.getState(); saveJobsCache(s.jobs, s.statuses); }
          useWsStore.getState().desktopOnline || useWsStore.setState({ desktopOnline: true });
          break;
        case "log_chunk":
          dispatchLogChunk(msg.name, msg.content);
          dispatchTransportLogChunk(msg.name, msg.content);
          break;
        case "detected_processes":
          useJobsStore.getState().setDetectedProcesses(msg.processes);
          useWsStore.getState().desktopOnline || useWsStore.setState({ desktopOnline: true });
          if (!useJobsStore.getState().loaded && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "list_jobs", id: nextId() }));
          }
          break;
        case "settings_response":
          useJobsStore.getState().setDesktopSettings(msg.enabled_models, msg.default_provider, msg.default_model);
          break;
        case "claude_questions":
          useNotificationStore.getState().setQuestions(msg.questions);
          saveQuestionsCache(msg.questions);
          break;
        case "auto_yes_panes":
          useNotificationStore.getState().setAutoYesPanes((msg as { pane_ids?: string[] }).pane_ids ?? []);
          break;
        case "pty_output":
          dispatchPtyOutput((msg as any).pane_id, (msg as any).data);
          break;
        case "pty_exit":
          dispatchPtyExit((msg as any).pane_id);
          break;
        case "notification_history":
          // Ignored - desktop sends authoritative claude_questions
          break;
        case "desktop_status":
          setDesktopStatus(msg.device_id, msg.device_name, msg.online);
          if (msg.online && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "list_jobs", id: nextId() }));
            ws.send(JSON.stringify({ type: "get_settings", id: nextId() }));
          }
          break;
        case "run_history":
          resolveRequest(msg.id, msg.runs);
          break;
        case "error":
          if (msg.id) {
            resolveRequest(msg.id, msg);
          }
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
      setWs(null);
      setWsSend(null);
      clearRegisteredSend();
      if (!mountedRef.current) return;
      setConnected(false);

      if (e.reason?.includes("403")) {
        // No subscription - relay is reachable but rejecting, stop reconnecting
        setConnected(true);
        return;
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
      // Check subscription to distinguish 403 (no sub) from 401 (auth issue).
      if (Platform.OS === "web" && e.code === 1006 && !e.reason) {
        getSubscriptionStatus()
          .then((sub) => {
            if (!mountedRef.current) return;
            if (!sub.subscribed) {
              // No subscription - relay is reachable but rejecting, stop reconnecting
              setConnected(true);
            } else {
              scheduleReconnect();
            }
          })
          .catch(() => {
            if (!mountedRef.current) return;
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
      console.log("[ws] error:", {
        type: (e as { type?: string }).type ?? "error",
        readyState: ws.readyState,
      });
    };

    setWsSend((msg: ClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });
  }, [setConnected, setDesktopStatus, setJobs, updateStatus, refreshToken, scheduleReconnect]);

  // Keep ref in sync
  connectRef.current = doConnect;

  useEffect(() => {
    mountedRef.current = true;
    if (isAuthenticated) {
      doConnect();
    }

    const sub = RNAppState.addEventListener("change", (state) => {
      const wasActive = appStateRef.current === "active";
      appStateRef.current = state;

      if (state === "active" && isAuthenticatedRef.current) {
        const ws = getWs();
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          backoffRef.current = 1000;
          connectRef.current();
        } else {
          ws.send(JSON.stringify({ type: "list_jobs", id: nextId() }));
          ws.send(JSON.stringify({ type: "get_settings", id: nextId() }));
          replayActivePtySubscriptions();
        }
      } else if (wasActive) {
        releaseActivePtySubscriptions();
      }
    });

    // Retry jobs until the first authoritative list arrives because desktop
    // status can be replayed before request forwarding is fully ready on
    // reconnect. Detected processes are daemon-pushed via relay cache.
    const processInterval = setInterval(() => {
      const send = getWsSend();
      if (send) {
        if (!useJobsStore.getState().loaded) {
          send({ type: "list_jobs", id: nextId() });
        }
      }
    }, 10000);

    return () => {
      mountedRef.current = false;
      sub.remove();
      clearInterval(processInterval);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      const ws = getWs();
      if (ws) {
        ws.close();
        setWs(null);
        setWsSend(null);
      }
      resetWs();
    };
  }, [isAuthenticated, doConnect, resetWs]);

  const send = useCallback((msg: ClientMessage) => {
    const wsSend = getWsSend();
    if (wsSend) wsSend(msg);
  }, []);

  return { send };
}
