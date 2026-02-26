import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

import { useNotificationStore } from "../store/notifications";
import { getWsSend, nextId } from "./useWebSocket";

export function useNotifications() {
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
            options?: { number: string; label: string }[];
          };
        } | undefined;

        const clawtab = data?.clawtab;
        if (!clawtab?.question_id || !clawtab?.pane_id) return;

        const actionId = response.actionIdentifier;

        if (actionId && actionId !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
          // User tapped an action button (number like "1", "2", etc.)
          const send = getWsSend();
          if (send) {
            send({
              type: "answer_question",
              id: nextId(),
              question_id: clawtab.question_id,
              pane_id: clawtab.pane_id,
              answer: actionId,
            });
          }
          answerQuestion(clawtab.question_id);
        } else {
          // User tapped the notification body - deep link to the card
          setDeepLinkQuestionId(clawtab.question_id);
        }
      },
    );

    return () => {
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [answerQuestion, setDeepLinkQuestionId]);
}
