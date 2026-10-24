import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { colors } from "@clawtab/shared"
import { useSetupProgress } from "../hooks/useSetupProgress"

export let DemoOverview = ({ onConnect }: { onConnect: () => void }) => {
  let router = useRouter()
  let { relayComplete, machineComplete, complete } = useSetupProgress()
  let addMachine = () => router.push("/add-machine")
  return <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent} contentInsetAdjustmentBehavior="automatic">
    <View style={styles.content}>
      <Text style={styles.eyebrow}>{complete ? "SETUP COMPLETE" : "GETTING STARTED"}</Text>
      <Text style={styles.title}>Your first agent, in two steps</Text>
      <Text style={styles.description}>Explore the sample agents and terminals. When you’re ready, connect ClawTab to your computer or server and control your agents from anywhere.</Text>
      <View style={styles.steps}>
        <View style={styles.step}>
          <View accessibilityLabel={relayComplete ? "Relay access complete" : "Step 1"} style={[styles.number, relayComplete && styles.completed]}><Text style={styles.numberText}>{relayComplete ? "✓" : "1"}</Text></View>
          <View style={styles.stepContent}>
            <Text style={styles.stepTitle}>Set up relay access</Text>
            <Text style={styles.description}>The relay connects your mobile and web apps to your machines. Sign in and subscribe to the hosted relay, or connect to a relay you host yourself.</Text>
            <Pressable accessibilityRole="button" onPress={onConnect} style={styles.button}><Text style={styles.buttonText}>{relayComplete ? "Relay connected" : "Set up relay"}</Text></Pressable>
          </View>
        </View>
        <View style={styles.step}>
          <View accessibilityLabel={machineComplete ? "Machine setup complete" : "Step 2"} style={[styles.number, machineComplete && styles.completed]}><Text style={styles.numberText}>{machineComplete ? "✓" : "2"}</Text></View>
          <View style={styles.stepContent}>
            <Text style={styles.stepTitle}>Connect a desktop or server</Text>
            <Text style={styles.description}>Install ClawTab on the machine where your agents will run. Install and sign in to your agent CLI there, such as Codex, Claude Code, OpenCode, or Hermes.</Text>
            <Text style={styles.description}>Run cwtctl setup on that machine, then approve its pairing code in Add machine.</Text>
            <Pressable accessibilityRole="button" onPress={addMachine} style={styles.button}><Text style={styles.buttonText}>{machineComplete ? "Add another machine" : "Add machine"}</Text></Pressable>
          </View>
        </View>
        <View style={styles.step}>
          <View style={styles.number}><Text style={styles.numberText}>→</Text></View>
          <View style={styles.stepContent}>
            <Text style={styles.stepTitle}>Launch agents from any device</Text>
            <Text style={styles.description}>From mobile, web, or desktop, choose your machine, project folder, and agent, then enter a prompt. You can also launch an agent directly in the terminal on that machine.</Text>
            <Text style={styles.description}>The agent runs where its CLI is installed. Follow its output, send prompts, and answer questions from your phone or desktop.</Text>
          </View>
        </View>
      </View>
      {Platform.OS === "web" && <View style={styles.rental}>
        <View style={styles.rentalText}>
          <Text style={styles.stepTitle}>Prefer a ready-to-use server?</Text>
          <Text style={styles.description}>Rent a box with ClawTab and agent CLIs installed. Relay access is included; sign in to your own AI accounts to get started.</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={addMachine} style={styles.button}><Text style={styles.buttonText}>Choose a box</Text></Pressable>
      </View>}
      <Text style={styles.hint}>Select a sample agent to explore. Select Demo to return to this guide.</Text>
    </View>
  </ScrollView>
}

let styles = StyleSheet.create({
  screen: { flex: 1, minWidth: 0, backgroundColor: colors.bg },
  scrollContent: { flexGrow: 1, padding: 24, paddingBottom: 40 },
  content: { width: "100%", maxWidth: 780, alignSelf: "center", gap: 20 },
  eyebrow: { color: colors.warning, fontSize: 12, fontWeight: "600", letterSpacing: 1.4 },
  title: { color: colors.text, fontSize: 28, fontWeight: "600", lineHeight: 36 },
  description: { color: colors.textSecondary, fontSize: 15, lineHeight: 23 },
  steps: { gap: 24, marginVertical: 8 },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 14 },
  number: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.accentBg, alignItems: "center", justifyContent: "center" },
  numberText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  completed: { borderWidth: 1, borderColor: colors.success },
  stepContent: { flex: 1, minWidth: 0, gap: 10 },
  stepTitle: { color: colors.text, fontSize: 18, fontWeight: "600", lineHeight: 26 },
  rental: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 16, padding: 20, backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border },
  rentalText: { flexGrow: 1, flexBasis: 280, gap: 8 },
  button: { minHeight: 44, paddingHorizontal: 20, paddingVertical: 12, alignSelf: "flex-start", alignItems: "center", justifyContent: "center", borderRadius: 999, backgroundColor: colors.accentBg, borderWidth: 1, borderColor: colors.accent },
  buttonText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  hint: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
})
