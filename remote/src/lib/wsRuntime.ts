import type { ClientMessage } from "../types/messages";

let globalWs: WebSocket | null = null;
let globalSend: ((msg: ClientMessage) => void) | null = null;
let msgIdCounter = 0;

export function getWs() {
  return globalWs;
}

export function setWs(ws: WebSocket | null) {
  globalWs = ws;
}

export function getWsSend() {
  return globalSend;
}

export function setWsSend(send: ((msg: ClientMessage) => void) | null) {
  globalSend = send;
}

export function nextId(): string {
  return `m_${++msgIdCounter}_${Date.now()}`;
}
