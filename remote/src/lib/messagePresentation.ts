import { messagePending, resourceKey, type MessageRecord } from "@clawtab/shared";
import type { MessageTarget } from "./messageRoutes";

export const surfaceId = (record: Pick<MessageRecord, "machine_id" | "id">) => resourceKey(record.machine_id, record.id);

export function surfaceRecord(record: MessageRecord) {
  return { ...record, id: surfaceId(record), request: { ...record.request,
    // Relative paths belong to the host. The media bridge replaces these before display.
    media: record.request.media?.map(media => ({ ...media })),
  } };
}

export function parseSurfaceId(id: string): MessageTarget {
  const index = id.indexOf("::");
  if (index < 1 || index === id.length - 2) throw new Error("Message machine is missing");
  return { machine: id.slice(0, index), id: id.slice(index + 2) };
}

export function findSurfaceRecord(records: MessageRecord[], id: string) {
  return records.find(record => surfaceId(record) === id);
}

export function targetRecord(records: MessageRecord[], target: MessageTarget) {
  return records.find(record => record.machine_id === target.machine && record.id === target.id);
}

export function newMessageArrival(previous: Set<string>, records: MessageRecord[]) {
  return records.filter(record => messagePending(record) && !previous.has(surfaceId(record)))
    .sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

export function messageArrivalTracker() {
  const seen = new Set<string>();
  const initialized = new Set<string>();
  return {
    observe(records: MessageRecord[], snapshots: Record<string, { messages_changed?: { records?: { id: string }[] } }>) {
      for (const [machine, snapshot] of Object.entries(snapshots)) {
        if (!snapshot.messages_changed || initialized.has(machine)) continue;
        for (const record of snapshot.messages_changed.records ?? []) seen.add(surfaceId({ machine_id: machine, id: record.id }));
        for (const record of records.filter(record => record.machine_id === machine)) seen.add(surfaceId(record));
        initialized.add(machine);
      }
      const arrival = newMessageArrival(seen, records.filter(record => initialized.has(record.machine_id)));
      for (const record of records) seen.add(surfaceId(record));
      return arrival;
    },
  };
}
