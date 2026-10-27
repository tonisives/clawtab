import { useEffect, useRef, useState } from "react";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMessageStore } from "../store/messages";
import { newMessageArrival, surfaceId } from "../lib/messagePresentation";
import { messagePath, type MessageTarget } from "../lib/messageRoutes";
import { MessageInbox } from "./MessageInbox";

export function MessageArrival() {
  const records = useMessageStore(state => state.records);
  const previous = useRef<Set<string> | null>(null);
  const [target, setTarget] = useState<MessageTarget | null>(null);
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const viewingMessages = pathname.startsWith("/notifications") || params.section === "notifications";
  useEffect(() => {
    const arrival = previous.current && newMessageArrival(previous.current, records);
    previous.current = new Set(records.map(surfaceId));
    if (arrival && !viewingMessages) setTarget(current => current ?? { machine: arrival.machine_id, id: arrival.id });
  }, [records, viewingMessages]);
  useEffect(() => { if (viewingMessages) setTarget(null); }, [viewingMessages]);
  if (!target || viewingMessages) return null;
  return <View style={[styles.popup, { top: insets.top + 52, right: Math.max(12, insets.right),
    width: Math.min(520, width - Math.max(12, insets.left) - Math.max(12, insets.right)),
    height: Math.min(430, height - insets.top - insets.bottom - 120) }]}>
    <View style={styles.toolbar}>
      <Pressable accessibilityRole="button" accessibilityLabel="Open this message" style={styles.open}
        onPress={() => { router.push(messagePath(target) as never); setTarget(null); }}><Text style={styles.label}>Open message</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Close message popup" style={styles.close}
        onPress={() => setTarget(null)}><Text style={styles.label}>Close</Text></Pressable>
    </View>
    <MessageInbox selection={`${target.machine}::${target.id}`} onNavigateAway={() => setTarget(null)}
      onNative={value => { if (value.native === "hide") setTarget(null); }} />
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
