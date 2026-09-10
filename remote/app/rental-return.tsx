import { useLocalSearchParams, useRouter } from "expo-router"
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text } from "react-native"
import { colors } from "@clawtab/shared"
import { MachineSetup } from "../src/components/MachineSetup"

let RentalReturn = () => {
  let router = useRouter()
  let { rental_id, platform, outcome } = useLocalSearchParams<{ rental_id?: string; platform?: string; outcome?: string }>()
  let appReturn = Platform.OS === "web" && ["desktop", "ios", "android"].includes(platform ?? "")
  let openApp = () => Linking.openURL(`clawtab://rental-return?rental_id=${encodeURIComponent(rental_id ?? "")}`)
  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.title}>{outcome === "cancel" ? "Checkout paused" : "Setting up your box"}</Text>
    <Text style={styles.detail}>{outcome === "cancel" ? "You can resume your order below." : "Payment is being verified. Your box will appear here as it connects. You can close this page and return to Machines at any time."}</Text>
    {appReturn && <Pressable accessibilityRole="button" onPress={openApp} style={styles.button}><Text style={styles.action}>Continue in ClawTab</Text></Pressable>}
    <MachineSetup />
    <Pressable accessibilityRole="button" onPress={() => router.replace("/(tabs)")} style={styles.button}><Text style={styles.action}>Go to jobs</Text></Pressable>
  </ScrollView>
}
export default RentalReturn

let styles = StyleSheet.create({
  page: { padding: 20, gap: 16 },
  title: { color: colors.text, fontSize: 22, fontWeight: "600" },
  detail: { color: colors.textSecondary, fontSize: 14 },
  button: { paddingVertical: 12 },
  action: { color: colors.accent, fontSize: 16 },
})
