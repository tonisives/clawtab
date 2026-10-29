import { Stack, useLocalSearchParams, useRouter } from "expo-router"
import { Pressable, StyleSheet, Text } from "react-native"
import { colors } from "@clawtab/shared"
import { DemoDetailsContent } from "../src/components/DemoDetailsContent"

export default function DemoAgentDetails() {
  let params = useLocalSearchParams<{ id: string; kind?: string }>()
  let router = useRouter()
  let close = () => router.back()
  let closeButton = () => <Pressable accessibilityRole="button" accessibilityLabel="Close agent details" onPress={close} style={styles.button}><Text style={styles.label}>Done</Text></Pressable>
  return <>
    <Stack.Screen options={{ headerRight: closeButton }} />
    <DemoDetailsContent {...params} />
  </>
}

let styles = StyleSheet.create({
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 999, backgroundColor: colors.groupedSurface, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  label: { color: colors.accent, fontSize: 14, fontWeight: "600" },
})
