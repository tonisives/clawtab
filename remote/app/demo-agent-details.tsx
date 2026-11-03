import { Stack, useLocalSearchParams, useRouter } from "expo-router"
import { Platform, Pressable, StyleSheet, Text } from "react-native"
import { colors } from "@clawtab/shared"
import { DemoDetailsContent } from "../src/components/DemoDetailsContent"

export default function DemoAgentDetails() {
  let params = useLocalSearchParams<{ id: string; kind?: string }>()
  let router = useRouter()
  let close = () => router.back()
  let closeButton = () => <Pressable accessibilityRole="button" accessibilityLabel="Close agent details" onPress={close} style={styles.button}><Text style={styles.label}>Done</Text></Pressable>
  return <>
    <Stack.Screen options={Platform.OS === "ios" ? {
      unstable_headerRightItems: () => [{ type: "button", label: "Done", accessibilityLabel: "Close agent details", onPress: close }],
    } : { headerRight: closeButton }} />
    <DemoDetailsContent {...params} />
  </>
}

let styles = StyleSheet.create({
  button: { minHeight: 44, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  label: { color: colors.accent, fontSize: 14, fontWeight: "600" },
})
