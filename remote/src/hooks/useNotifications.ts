import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";

import { useNotificationStore } from "../store/notifications";
import { getWsSend, nextId } from "./useWebSocket";
import { enqueueAnswer } from "../lib/pendingAnswers";
import { postAnswer } from "../api/client";

function handleNotificationResponse(
  response: Notifications.NotificationResponse,
  answerQuestion: (id: string) => void,
  navigate: (path: string) => void,
) {
  const data = response.notification.request.content.data as {
    clawtab?: {
      question_id?: string;
      pane_id?: string;
      matched_job?: string;
      options?: { number: string; label: string }[];
      job_name?: string;
      run_id?: string;
    };
  } | undefined;

  const clawtab = data?.clawtab;
  if (!clawtab) return;

  // Job notification (no question_id means it's a job status push)
  if (clawtab.job_name && !clawtab.question_id) {
    const params = clawtab.run_id ? `?run_id=${clawtab.run_id}` : "";
    navigate(`/job/${clawtab.job_name}${params}`);
    return;
  }

  // Question notification
  if (!clawtab.question_id || !clawtab.pane_id) return;

  // Inject the question from the notification payload so it's
  // visible immediately, even if WS hasn't connected yet.
  const notifContent = response.notification.request.content;
  useNotificationStore.getState().injectFromNotification({
    pane_id: clawtab.pane_id,
    cwd: "",
    tmux_session: "",
    window_name: "",
    question_id: clawtab.question_id,
    context_lines: typeof notifContent.body === "string" ? notifContent.body : "",
    options: clawtab.options ?? [],
    matched_job: clawtab.matched_job ?? null,
    matched_group: null,
  });

  const actionId = response.actionIdentifier;

  if (actionId && actionId !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
    // User tapped an action button (number like "1", "2", etc.)
    // Try HTTP POST first (works even without WS connection),
    // fall back to WS, then queue for later.
    const qid = clawtab.question_id;
    const pid = clawtab.pane_id;
    console.log("[notif] answering via HTTP:", qid, actionId);
    postAnswer(qid, pid, actionId)
      .then((res) => console.log("[notif] HTTP answer sent, desktop:", res.sent))
      .catch((err) => {
        console.log("[notif] HTTP answer failed:", err, "- falling back");
        const send = getWsSend();
        if (send) {
          console.log("[notif] fallback: sending via WS");
          send({
            type: "answer_question" as const,
            id: nextId(),
            question_id: qid,
            pane_id: pid,
            answer: actionId,
          });
        } else {
          console.log("[notif] fallback: queuing to AsyncStorage");
          enqueueAnswer({
            type: "answer_question" as const,
            id: nextId(),
            question_id: qid,
            pane_id: pid,
            answer: actionId,
          });
        }
      });
    answerQuestion(clawtab.question_id);
    // Dismiss the notification from the notification center
    Notifications.dismissNotificationAsync(
      response.notification.request.identifier,
    ).catch(() => {});
  }

  // Navigate to the job/process screen
  if (clawtab.matched_job) {
    navigate(`/job/${clawtab.matched_job}`);
  } else {
    navigate(`/process/${clawtab.pane_id.replace(/%/g, "_pct_")}`);
  }
}

export function useNotifications() {
  const router = useRouter();
  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const setDeepLinkQuestionId = useNotificationStore((s) => s.setDeepLinkQuestionId);
  const responseListener = useRef<Notifications.Subscription | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") return;

    const navigate = (path: string) => router.push(path as never);

    // Check for notification response that launched the app (cold start).
    // The listener below only catches responses that arrive *after* it's
    // registered, so a cold-launch tap would be missed without this.
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        console.log("[notif] cold-start response found:", response.actionIdentifier);
        handleNotificationResponse(response, answerQuestion, navigate);
      }
    });

    // Listen for notification responses (user taps notification or action button)
    responseListener.current = Notifications.addNotificationResponseReceivedListener(
      (response) => handleNotificationResponse(response, answerQuestion, navigate),
    );

    return () => {
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [answerQuestion, setDeepLinkQuestionId, router]);
}
