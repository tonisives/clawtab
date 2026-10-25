import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { colors } from "@clawtab/shared"

export let RelayWelcome = ({ onContinue, connected = false, children }: { onContinue?: () => void; connected?: boolean; children?: ReactNode }) => <View style={styles.welcome}>
  <Text style={styles.eyebrow}>GET STARTED WITH RELAY</Text>
  <Text accessibilityRole="header" style={styles.title}>Your agents, ready to run remotely.</Text>
  <Text style={styles.description}>Subscribe to Relay and get a remote workspace for your existing Claude, Codex, or other AI subscription.</Text>
  <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.heading}>One subscription. Your workspace included.</Text>
    <Text style={styles.description}>We create your workspace and connect it to Relay automatically. Choose an agent, sign in with your existing AI account, and start working from your phone or browser.</Text>
    <View style={styles.providers} accessibilityLabel="Available agents">
      {["Claude Code", "Codex", "OpenCode", "Hermes"].map((name) => <View key={name} style={styles.provider}><Text style={styles.providerText}>{name}</Text></View>)}
    </View>
    <Text style={styles.included}>Run 2 agents at once · Save 2 scheduled jobs</Text>
    {Platform.OS === "web" && !connected && <Text style={styles.price}>US$6.99 / month</Text>}
    {onContinue && <Pressable accessibilityRole="button" onPress={onContinue} style={styles.button}><Text style={styles.buttonText}>{connected ? "Open Relay workspace" : "Get started with Relay"}</Text></Pressable>}
    {children}
    <Text style={styles.detail}>Agent tools are already installed. Use the AI subscription or API account you already have.</Text>
  </View>
</View>

export let AdvancedSetupOptions = () => {
  let router = useRouter()
  let connect = () => router.push({ pathname: "/add-machine", params: { setup: "connect" } })
  let rent = () => router.push({ pathname: "/add-machine", params: { setup: "rent" } })
  let serverGuide = () => { void Linking.openURL("https://clawtab.cc/articles/setup-remote-machines") }
  let relayGuide = () => { void Linking.openURL("https://clawtab.cc/docs#deploy") }
  return <View style={styles.advanced}>
    <Text accessibilityRole="header" style={styles.heading}>Advanced setup</Text>
    <Text style={styles.detail}>Need more capacity or want to use hardware you already have?</Text>
    <Option title="Connect your computer or server" detail="Keep your existing agents and projects on your own machine." onPress={connect} />
    {Platform.OS === "web" && <Option title="Rent a larger box" detail="Get a dedicated server with more CPU, memory, and storage." onPress={rent} />}
    <Option title="Install or deploy the daemon" detail="Set up ClawTab on your own Linux server or Kubernetes cluster." onPress={serverGuide} external />
    <Option title="Host your own relay" detail="Manage the relay infrastructure yourself." onPress={relayGuide} external />
  </View>
}

let Option = ({ title, detail, onPress, external = false }: { title: string; detail: string; onPress: () => void; external?: boolean }) => <Pressable accessibilityRole={external ? "link" : "button"} onPress={onPress} style={styles.option}>
  <View style={styles.optionText}><Text style={styles.link}>{title}</Text><Text style={styles.detail}>{detail}</Text></View>
  <Text style={styles.arrow} accessibilityElementsHidden>{external ? "↗" : "›"}</Text>
</Pressable>

let styles = StyleSheet.create({
  welcome: { gap: 18 },
  eyebrow: { color: colors.accent, fontSize: 12, fontWeight: "600", letterSpacing: 1.4 },
  title: { color: colors.text, fontSize: 30, fontWeight: "600", lineHeight: 38 },
  description: { color: colors.textSecondary, fontSize: 15, lineHeight: 23 },
  card: { padding: 24, gap: 16, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  heading: { color: colors.text, fontSize: 18, fontWeight: "600", lineHeight: 26 },
  providers: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  provider: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.groupedSurface },
  providerText: { color: colors.text, fontSize: 13, fontWeight: "500" },
  included: { color: colors.text, fontSize: 15, fontWeight: "500", lineHeight: 23 },
  price: { color: colors.text, fontSize: 22, fontWeight: "600" },
  detail: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
  button: { minHeight: 48, paddingHorizontal: 24, paddingVertical: 12, alignSelf: "flex-start", alignItems: "center", justifyContent: "center", borderRadius: 999, backgroundColor: colors.accent },
  buttonText: { color: colors.bg, fontSize: 15, fontWeight: "600" },
  advanced: { gap: 12, paddingTop: 24, borderTopWidth: 1, borderTopColor: colors.border },
  option: { flexDirection: "row", alignItems: "center", gap: 16, minHeight: 60, paddingVertical: 10 },
  optionText: { flex: 1, gap: 4 },
  link: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  arrow: { color: colors.textMuted, fontSize: 20 },
})
import type { ReactNode } from "react"
