import { useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { MessageInbox } from "../../../src/components/MessageInbox";

export default function MessageScreen() {
  const params = useLocalSearchParams<{ id: string; machine: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const machine = typeof params.machine === "string" ? params.machine : "";
  return <View style={styles.root}><MessageInbox selection={machine && id ? `${machine}::${id}` : null} /></View>;
}

const styles = StyleSheet.create({ root: { flex: 1, minHeight: 0, backgroundColor: "#161616" } });
