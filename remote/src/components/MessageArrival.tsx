import { useEffect, useState } from "react";
import { useMachines } from "@clawtab/shared";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useMessageStore } from "../store/messages";
import { messageArrivalTracker } from "../lib/messagePresentation";
import { messagePath } from "../lib/messageRoutes";

export function MessageArrival() {
  const records = useMessageStore(state => state.records);
  const { snapshots } = useMachines();
  const [arrivals] = useState(messageArrivalTracker);
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const router = useRouter();
  const viewingMessages = pathname.startsWith("/notifications") || params.section === "notifications";
  useEffect(() => {
    const arrival = arrivals.observe(records, snapshots);
    if (arrival && !viewingMessages) router.push(messagePath({ machine: arrival.machine_id, id: arrival.id }) as never);
  }, [records, snapshots, arrivals, viewingMessages, router]);
  return null;
}
