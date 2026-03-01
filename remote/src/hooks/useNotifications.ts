import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";

import { useNotificationStore } from "../store/notifications";
import { getWsSend, nextId } from "./useWebSocket";
import { enqueueAnswer } from "../lib/pendingAnswers";

export function useNotifications() {
  const router = useRouter();
  const answerQuestion = useNotificationStore((s) => s.answerQuestion);
  const setDeepLinkQuestionId = useNotificationStore((s) => s.setDeepLinkQuestionId);
  const responseListener = useRef<Notifications.Subscription | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") return;

    // Listen for notification responses (user taps notification or action button)
    responseListener.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
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
          router.push(`/job/${clawtab.job_name}${params}`);
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
          const answerMsg = {
            type: "answer_question" as const,
            id: nextId(),
            question_id: clawtab.question_id,
            pane_id: clawtab.pane_id,
            answer: actionId,
          };
          const send = getWsSend();
          if (send) {
            send(answerMsg);
          } else {
            enqueueAnswer(answerMsg);
          }
          answerQuestion(clawtab.question_id);
        }

        // Navigate to the job/process screen
        if (clawtab.matched_job) {
          router.push(`/job/${clawtab.matched_job}`);
        } else {
          router.push(`/process/${clawtab.pane_id.replace(/%/g, "_pct_")}`);
        }
      },
    );

    return () => {
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [answerQuestion, setDeepLinkQuestionId, router]);
}
