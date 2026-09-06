import { useCallback, useEffect, useRef, useState } from "react";
import type { PaneOverviewActions } from "@clawtab/shared";
import type { AgentActionDescriptor, AgentActionRun } from "../types/messages";
import { getWsSend, nextId } from "../lib/wsRuntime";
import { clearRequest, registerRequest } from "../lib/useRequestMap";
import { subscribeAgentActionProgress } from "../lib/agentActions";
import { useWsStore } from "../store/ws";

export let useAgentActions = (paneId: string, visible: boolean): PaneOverviewActions => {
  let connected = useWsStore((state) => state.connected);
  let [actions, setActions] = useState<AgentActionDescriptor[]>([]);
  let [run, setRun] = useState<AgentActionRun | null>(null);
  let currentPane = useRef(paneId);
  let starting = useRef(false);
  currentPane.current = paneId;

  useEffect(() => { setActions([]); setRun(null); }, [paneId]);

  useEffect(() => {
    if (!visible || !paneId || !connected) return;
    let send = getWsSend();
    if (!send) return;
    let active = true;
    let id = nextId();
    let response = registerRequest<{ actions?: AgentActionDescriptor[] }>(id);
    let timer = setTimeout(() => { clearRequest(id); }, 10_000);
    send({ type: "list_agent_actions", id, pane_id: paneId });
    response.then((result) => {
      clearTimeout(timer);
      if (active) setActions(result.actions ?? []);
    });
    return () => { active = false; clearTimeout(timer); clearRequest(id); };
  }, [paneId, visible, connected]);

  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.state)) return;
    let active = true;
    let pendingId: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let poll = () => {
      let send = getWsSend();
      if (!send || pendingId) return;
      let id = nextId();
      pendingId = id;
      let response = registerRequest<{ run?: AgentActionRun }>(id);
      timeout = setTimeout(() => { clearRequest(id); pendingId = undefined; }, 5000);
      send({ type: "get_agent_action_run", id, run_id: run.run_id });
      response.then((result) => {
        clearTimeout(timeout);
        pendingId = undefined;
        if (active && result.run) setRun(result.run);
      });
    };
    let unsubscribe = subscribeAgentActionProgress(run.run_id, setRun);
    let timer = setInterval(poll, 1000);
    poll();
    return () => { active = false; unsubscribe(); clearInterval(timer); clearTimeout(timeout); if (pendingId) clearRequest(pendingId); };
  }, [run?.run_id, run?.state]);

  let onRunAgentAction = useCallback(async (actionId: string, parameters: Record<string, string> = {}) => {
    let send = getWsSend();
    if (!send || starting.current || run && ["queued", "running"].includes(run.state)) return;
    starting.current = true;
    let id = nextId();
    let response = registerRequest<{ run?: AgentActionRun; error?: string; message?: string }>(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    send({ type: "start_agent_action", id, pane_id: paneId, action_id: actionId, parameters });
    try {
      let result = await Promise.race([response, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 10_000); })]);
      if (currentPane.current !== paneId) return;
      setRun(result?.run ?? {
        run_id: id, pane_id: paneId, action_id: actionId, state: "failed",
        progress: "Could not confirm action start", progress_percent: 100,
        error: result?.error ?? result?.message ?? "No response from desktop. Check the agent before retrying.",
      });
    } finally { starting.current = false; clearTimeout(timer); clearRequest(id); }
  }, [paneId, run]);

  let onCancelAgentAction = useCallback(() => {
    if (run) getWsSend()?.({ type: "cancel_agent_action", id: nextId(), run_id: run.run_id });
  }, [run]);

  return {
    agentActions: actions,
    agentActionRun: run ? { state: run.state, progress: run.progress, progressPercent: run.progress_percent, error: run.error } : null,
    onRunAgentAction,
    onCancelAgentAction,
  };
};
