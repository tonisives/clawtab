import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";

import { useNotificationStore } from "../store/notifications";
import { getWsSend, nextId } from "./useWebSocket";
import { enqueueAnswer } from "../lib/pendingAnswers";
import { postAnswer, refreshToken } from "../api/client";

// Track which responses we've already sent answers for / navigated for,
// to avoid double-processing between cold-start and the listener.
const answeredResponses = new Set<string>();
const navigatedResponses = new Set<string>();

// Pending navigation target from cold start (set before router is ready)
let pendingNavigation: string | null = null;
export function consumePendingNavigation(): string | null {
  const target = pendingNavigation;
  pendingNavigation = null;
  return target;
}

function responseKey(response: Notifications.NotificationResponse): string {
  return `${response.notification.request.identifier}_${response.actionIdentifier}`;
}

async function sendAnswer(questionId: string, paneId: string, actionId: string) {
  console.log("[notif] answering: " + questionId + " " + actionId);
  const msg = {
    type: "answer_question" as const,
    id: nextId(),
    question_id: questionId,
    pane_id: paneId,
    answer: actionId,
  };

  const send = getWsSend();
  if (send) {
    console.log("[notif] sending via WS");
    send(msg);
    return;
  }

  try {
    await refreshToken().catch(() => {});
    const res = await postAnswer(questionId, paneId, actionId);
    console.log("[notif] HTTP answer sent, desktop: " + res.sent);
    return;
  } catch (err) {
    console.log("[notif] HTTP answer failed: " + err);
  }

  console.log("[notif] queuing answer to AsyncStorage");
  await enqueueAnswer(msg);
}

async function handleNotificationResponse(
  response: Notifications.NotificationResponse,
  answerQuestion: (id: string) => void,
  navigate?: (path: string) => void,
) {
  const key = responseKey(response);
  const alreadyAnswered = answeredResponses.has(key);
  const alreadyNavigated = navigatedResponses.has(key);
  console.log("[notif] handle key=" + key + " action=" + response.actionIdentifier + " nav=" + !!navigate + " answered=" + alreadyAnswered + " navigated=" + alreadyNavigated);
  if (alreadyAnswered && (alreadyNavigated || !navigate)) {
    console.log("[notif] skipping (already handled)");
    return;
  }

  // For remote notifications, Expo puts content.data = userInfo["body"] which
  // we don't use. The full APNs userInfo is at trigger.payload instead.
  const trigger = response.notification.request.trigger as { payload?: Record<string, unknown> } | null;
  const contentData = response.notification.request.content.data;
  const source = contentData?.clawtab ? contentData : trigger?.payload;

  const clawtab = (source as { clawtab?: {
    question_id?: string;
    pane_id?: string;
    matched_job?: string;
    options?: { number: string; label: string }[];
    job_name?: string;
    run_id?: string;
  } } | undefined)?.clawtab;

  if (!clawtab) {
    console.log("[notif] no clawtab data, content.data=" + JSON.stringify(contentData) + " trigger.payload=" + JSON.stringify(trigger?.payload));

    return;
  }
  console.log("[notif] clawtab q=" + clawtab.question_id + " pane=" + clawtab.pane_id + " job=" + clawtab.matched_job);

  // Job notification (no question_id means it's a job status push)
  if (clawtab.job_name && !clawtab.question_id) {
    if (navigate && !alreadyNavigated) {
      navigatedResponses.add(key);
      const params = clawtab.run_id ? `?run_id=${clawtab.run_id}` : "";
      navigate(`/job/${clawtab.job_name}${params}`);
    }
    return;
  }

  // Question notification
  if (!clawtab.question_id || !clawtab.pane_id) return;

  if (!alreadyAnswered) {
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

    answeredResponses.add(key);
  }

  // Action button taps are fully handled by native NativeAnswerHandler
  // (returns true, iOS keeps process alive for HTTP). When app is in
  // foreground, this JS code also runs - just update local state, no nav.
  const actionId = response.actionIdentifier;
  if (actionId && actionId !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
    console.log("[notif] action button tap, native handler sends answer");
    answerQuestion(clawtab.question_id);
    Notifications.dismissNotificationAsync(
      response.notification.request.identifier,
    ).catch(() => {});
    return;
  }

  // Navigate to the job/process screen
  if (navigate && !alreadyNavigated) {
    navigatedResponses.add(key);
    const target = clawtab.matched_job
      ? `/job/${clawtab.matched_job}`
      : `/process/${clawtab.pane_id.replace(/%/g, "_pct_")}`;
    console.log("[notif] navigating to: " + target);

    navigate(target);
  } else {
    console.log("[notif] skip nav: navigate=" + !!navigate + " navigated=" + alreadyNavigated);
  }
}

// Call this early (e.g. from root layout) to handle cold-start answers
// before the router is ready. Only sends the answer, no navigation.
export function handleColdStartAnswer() {
  if (Platform.OS === "web") return;
  console.log("[notif] handleColdStartAnswer called");
  const answerQuestion = useNotificationStore.getState().answerQuestion;
  Notifications.getLastNotificationResponseAsync().then((response) => {
    console.log("[notif] cold-start getLast: " + (response ? response.actionIdentifier : "null"));
    if (response) {
      const trigger = response.notification.request.trigger as { payload?: Record<string, unknown> } | null;
      const contentData = response.notification.request.content.data;
      const source = contentData?.clawtab ? contentData : trigger?.payload;
      const ct = (source as { clawtab?: { question_id?: string; pane_id?: string; matched_job?: string; job_name?: string; run_id?: string } } | undefined)?.clawtab;
      if (ct) {
        // Only set pending navigation for body taps, not action button taps
        const isBodyTap = response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER;
        if (isBodyTap) {
          if (ct.job_name && !ct.question_id) {
            const params = ct.run_id ? `?run_id=${ct.run_id}` : "";
            pendingNavigation = `/job/${ct.job_name}${params}`;
          } else if (ct.matched_job) {
            pendingNavigation = `/job/${ct.matched_job}`;
          } else if (ct.pane_id) {
            pendingNavigation = `/process/${ct.pane_id.replace(/%/g, "_pct_")}`;
          }
        }
        console.log("[notif] cold-start pending: " + pendingNavigation + " (bodyTap=" + isBodyTap + ")");
      } else {
        console.log("[notif] cold-start no clawtab, data=" + JSON.stringify(response.notification.request.content.data));
      }

      handleNotificationResponse(response, answerQuestion);
    } else {

    }
  });
}

export function useNotifications() {
  const router = useRouter();
  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const setDeepLinkQuestionId = useNotificationStore((s) => s.setDeepLinkQuestionId);
  const responseListener = useRef<Notifications.Subscription | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") return;

    const navigate = (path: string) => {
      console.log("[notif] router.push: " + path);
      router.push(path as never);
    };

    // Check if cold-start stored a pending navigation target
    const pending = consumePendingNavigation();
    if (pending) {
      console.log("[notif] consuming pending: " + pending);
      navigate(pending);
    }

    console.log("[notif] useNotifications effect, checking getLast");
    Notifications.getLastNotificationResponseAsync().then((response) => {
      console.log("[notif] useNotif getLast: " + (response ? response.actionIdentifier : "null"));
      if (response) {
        handleNotificationResponse(response, answerQuestion, navigate);
      }
    });

    console.log("[notif] registering listener");
    responseListener.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        console.log("[notif] listener fired: " + response.actionIdentifier);
        handleNotificationResponse(response, answerQuestion, navigate);
      },
    );

    return () => {
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [answerQuestion, setDeepLinkQuestionId, router]);
}
