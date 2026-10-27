export type MessageTarget = { machine: string; id: string };

export function messagePath({ machine, id }: MessageTarget) {
  return `/notifications/message/${encodeURIComponent(id)}?machine=${encodeURIComponent(machine)}`;
}

export function messageTarget(data: unknown): MessageTarget | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  return typeof value.machine_id === "string" && value.machine_id.length > 0
    && typeof value.message_id === "string" && value.message_id.length > 0
    ? { machine: value.machine_id, id: value.message_id } : null;
}
