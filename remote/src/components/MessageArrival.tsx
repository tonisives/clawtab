import { useEffect, useState } from "react";
import { useMachines } from "@clawtab/shared";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMessageStore } from "../store/messages";
import { messageArrivalTracker, surfaceId } from "../lib/messagePresentation";
import { messagePath, type MessageTarget } from "../lib/messageRoutes";
import { MessageInbox } from "./MessageInbox";

export function MessageArrival() {
  const records = useMessageStore(state => state.records);
  const { snapshots } = useMachines();
  const [arrivals] = useState(messageArrivalTracker);
  const [popup, setPopup] = useState<{ target: MessageTarget; arrival: string } | null>(null);
  const target = popup?.target;
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const viewingMessages = pathname.startsWith("/notifications") || params.section === "notifications";
  useEffect(() => {
    const arrival = arrivals.observe(records, snapshots);
    if (arrival && !viewingMessages) setPopup(current => ({
      target: current?.target ?? { machine: arrival.machine_id, id: arrival.id }, arrival: surfaceId(arrival),
    }));
  }, [records, snapshots, arrivals, viewingMessages]);
  useEffect(() => { if (viewingMessages) setPopup(null); }, [viewingMessages]);
  const active = Boolean(target) && !viewingMessages;
  // Keep the local renderer ready between arrivals instead of starting WebKit
  // after the popup is already visible.
  return <View pointerEvents={active ? "auto" : "none"} accessibilityElementsHidden={!active} importantForAccessibility={active ? "auto" : "no-hide-descendants"}
    style={[styles.popup, { opacity: active ? 1 : 0, top: insets.top + 52, right: Math.max(12, insets.right),
    width: Math.min(520, width - Math.max(12, insets.left) - Math.max(12, insets.right)),
    height: Math.min(430, height - insets.top - insets.bottom - 120) }]}>
    <View style={styles.toolbar}>
      <Pressable accessibilityRole="button" accessibilityLabel="Open this message" style={styles.open}
        onPress={() => { if (target) router.push(messagePath(target) as never); setPopup(null); }}><Text style={styles.label}>Open message</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Close message popup" style={styles.close}
        onPress={() => setPopup(null)}><Text style={styles.label}>Close</Text></Pressable>
    </View>
    <MessageInbox popup active={active} selection={target ? `${target.machine}::${target.id}` : null} arrival={popup?.arrival} onNavigateAway={() => setPopup(null)}
      onNative={value => { if (value.native === "presentation" && value.active === false) setPopup(null); }} />
  </View>;
}

const styles = StyleSheet.create({
  popup: { position: "absolute", zIndex: 1000, elevation: 20, overflow: "hidden", backgroundColor: "#161616", borderWidth: 1,
    borderColor: "#333", borderRadius: 10, shadowColor: "#000", shadowOffset: { width: 0, height: 7 }, shadowRadius: 24, shadowOpacity: 0.3 },
  toolbar: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 1, borderColor: "#2a2a2a" },
  open: { flex: 1, padding: 12 },
  close: { padding: 12 },
  label: { color: "#98989d", fontSize: 13 },
});
