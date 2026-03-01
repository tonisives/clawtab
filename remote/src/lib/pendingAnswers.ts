import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ClientMessage } from "../types/messages";

const KEY = "clawtab_pending_answers";

type AnswerMessage = Extract<ClientMessage, { type: "answer_question" }>;

let queue: AnswerMessage[] = [];

export async function loadPendingAnswers(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) queue = JSON.parse(raw);
  } catch (e) {
    console.log("[pending] failed to load:", e);
  }
}

export function enqueueAnswer(msg: AnswerMessage) {
  queue.push(msg);
  AsyncStorage.setItem(KEY, JSON.stringify(queue)).catch((e) =>
    console.log("[pending] failed to persist:", e),
  );
}

export function flushPendingAnswers(
  send: (msg: ClientMessage) => void,
): void {
  if (queue.length === 0) return;
  console.log("[pending] flushing", queue.length, "queued answers");
  for (const msg of queue) {
    send(msg);
  }
  queue = [];
  AsyncStorage.removeItem(KEY).catch((e) =>
    console.log("[pending] failed to clear:", e),
  );
}
