import { getWsSend, nextId } from "./wsRuntime";
import { clearRequest, registerRequest } from "./useRequestMap";

// A pane can contain a login prompt or shell without a detected agent.
export let stopSession = async (paneId: string, timeoutMs = 30000) => {
  let send = getWsSend();
  if (!send) throw new Error("Not connected. Reconnect and try stopping the session again.");
  let id = nextId();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reply = registerRequest<{ success?: boolean; error?: string }>(id);
  try {
    let timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Stop was not confirmed. Check the connection and try again.")), timeoutMs);
    });
    send({ type: "stop_detected_process", id, pane_id: paneId });
    let ack = await Promise.race([reply, timeout]);
    if (ack.success !== true) throw new Error(ack.error || "Could not stop the session.");
  } finally {
    clearTimeout(timer);
    clearRequest(id);
  }
};
