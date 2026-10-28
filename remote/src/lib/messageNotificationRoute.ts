import { messagePath, messageTarget } from "./messageRoutes";

type NotificationResponse = {
  notification: { request: {
    content: { data?: Record<string, unknown> };
    trigger?: unknown;
  } };
};

export function messageNotificationRoute(response: NotificationResponse): string | null {
  const { content, trigger } = response.notification.request;
  const payload = trigger as { payload?: { clawtab?: unknown } } | null;
  const clawtab = content.data?.clawtab ?? payload?.payload?.clawtab;
  const target = messageTarget(clawtab);
  return target ? messagePath(target) : null;
}
