import { useLocalSearchParams } from "expo-router";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MessageInbox } from "../../../src/components/MessageInbox";

export default function MessageScreen() {
  const params = useLocalSearchParams<{ id: string; machine: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const machine = typeof params.machine === "string" ? params.machine : "";
  return <SafeAreaView edges={["bottom"]} style={styles.root}><MessageInbox selection={machine && id ? `${machine}::${id}` : null} /></SafeAreaView>;
}

const styles = StyleSheet.create({ root: { flex: 1, minHeight: 0, backgroundColor: "#161616" } });
