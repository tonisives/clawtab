import { useRouter } from "expo-router"
import { Platform, Pressable } from "react-native"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { colors } from "@clawtab/shared"
import { useSetupProgress } from "../hooks/useSetupProgress"
import { AdvancedSetupOptions, RelayWelcome } from "./RelayWelcome"
import { RelaySubscription } from "./settings/RelaySubscription"
import { useAuthStore } from "../store/auth"
import { useResponsive } from "../hooks/useResponsive"

export let DemoOverview = ({ onConnect, showSamples = true }: { onConnect: () => void; showSamples?: boolean }) => {
  let { isIosPhoneLandscape } = useResponsive()
  let router = useRouter()
  let connectComputer = () => router.push({ pathname: "/add-machine", params: { setup: "connect" } })
  let { relayComplete } = useSetupProgress()
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  return <ScrollView style={styles.screen} contentContainerStyle={[styles.scrollContent, isIosPhoneLandscape && { padding: 12, paddingBottom: 16 }]} contentInsetAdjustmentBehavior="automatic">
    <View style={styles.content}>
      {showSamples && relayComplete && <View style={styles.nextStep}>
        <Text accessibilityRole="header" style={styles.heading}>Use your own agents</Text>
        <Text style={styles.description}>Connect the computer where your Codex, Claude Code, or OpenCode sessions run. Open a live terminal, then answer an agent question from here.</Text>
        <Pressable accessibilityRole="button" onPress={connectComputer} style={styles.button}><Text style={styles.buttonText}>Connect your computer</Text></Pressable>
        <Text style={styles.hint}>Hosted Relay needs a subscription; you can also host your own relay.</Text>
      </View>}
      {Platform.OS === "web" && authenticated && !relayComplete ? <RelaySubscription /> : <RelayWelcome onContinue={onConnect} connected={relayComplete} />}
      <AdvancedSetupOptions />
    </View>
  </ScrollView>
}

let styles = StyleSheet.create({
  screen: { flex: 1, minWidth: 0, backgroundColor: colors.bg },
  scrollContent: { flexGrow: 1, padding: 24, paddingBottom: 40 },
  content: { width: "100%", maxWidth: 780, alignSelf: "center", gap: 28 },
  nextStep: { gap: 16 },
  heading: { color: colors.text, fontSize: 24, fontWeight: "600" },
  description: { color: colors.textSecondary, fontSize: 16, lineHeight: 24 },
  button: { backgroundColor: colors.accent, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, alignItems: "center" },
  buttonText: { color: colors.bg, fontSize: 16, fontWeight: "600" },
  hint: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
})
