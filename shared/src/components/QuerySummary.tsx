import { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";

type Props = { firstQuery?: string | null; lastQuery?: string | null };
export let QuerySummary = ({ firstQuery, lastQuery }: Props) => {
  let [hovered, setHovered] = useState(false);
  let [open, setOpen] = useState(false);
  let queries = [
    ...(firstQuery ? [{ label: "First query", text: firstQuery }] : []),
    ...(lastQuery && lastQuery !== firstQuery ? [{ label: "Latest query", text: lastQuery }] : []),
  ];
  let show = () => { setHovered(false); setOpen(true); };
  let close = () => setOpen(false);
  let enter = () => { if (Platform.OS === "web" && !open) setHovered(true); };
  let leave = () => setHovered(false);
  if (!queries.length) return null;
  let content = <ScrollView style={styles.scroll}>{queries.map((query) => <View key={query.label} style={styles.query}><Text style={styles.label}>{query.label}</Text><Text selectable style={styles.text}>{query.text}</Text></View>)}</ScrollView>;
  return <View style={styles.wrapper} onPointerEnter={enter} onPointerLeave={leave}>
    <Pressable onPress={show} accessibilityRole="button" accessibilityLabel="Show queries" style={styles.button}><Text style={styles.text}>Queries ...</Text></Pressable>
    {hovered && <View style={styles.popover}>{content}</View>}
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Close queries">
        <Pressable style={styles.dialog} onPress={(event) => event.stopPropagation()}>
          <View style={styles.header}><Text style={styles.title}>Queries</Text><Pressable onPress={close} accessibilityRole="button"><Text style={styles.text}>Close</Text></Pressable></View>
          {content}
        </Pressable>
      </Pressable>
    </Modal>
  </View>;
};
let styles = StyleSheet.create({
  wrapper: { position: "relative", alignSelf: "flex-start", zIndex: 100 },
  button: { paddingHorizontal: 10, paddingVertical: 7 },
  popover: { position: "absolute", top: "100%", left: 0, width: 420, maxWidth: "90vw", maxHeight: 360, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, padding: 12, zIndex: 1000 } as any,
  scroll: { flexShrink: 1 },
  query: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border },
  label: { color: colors.textSecondary, fontSize: 12, marginBottom: 6 },
  text: { color: colors.text, fontSize: 13 },
  title: { color: colors.text, fontWeight: "600", fontSize: 16 },
  backdrop: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20, backgroundColor: "rgba(0,0,0,0.5)" },
  dialog: { width: "100%", maxWidth: 720, maxHeight: "85%", padding: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
});
