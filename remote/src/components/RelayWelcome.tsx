import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { useState, type ReactNode } from "react"
import { Ionicons } from "@expo/vector-icons"
import { useRouter } from "expo-router"
import { colors } from "@clawtab/shared"

export let RelayWelcome = ({ onContinue, connected = false, children }: { onContinue?: () => void; connected?: boolean; children?: ReactNode }) => {
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>Relay</Text>
    {Platform.OS === "web" && !connected && <Text style={styles.price}>US$6.99 / month</Text>}
    <View style={styles.features}>
      <Feature label="About agents on our servers" detail="Relay creates and connects your workspace automatically. Claude Code, Codex, OpenCode, and Hermes are installed. Includes 2 saved scheduled jobs, sharing 0.5 CPU, 500 MiB memory, and 500 MiB storage.">
        Run <Text style={styles.emphasis}>2 agents at once</Text> on our servers.
      </Feature>
      <Feature label="About agents on your own machines" detail="Install ClawTab and connect your desktop or server from Advanced setup. Relay connects up to 100 agents across your own machines. Keep those machines online to reach their agents.">
        Connect <Text style={styles.emphasis}>up to 100 agents</Text> on your own computers or servers.
      </Feature>
    </View>
    <Text style={styles.description}>Use your existing Claude, Codex, or other AI account.</Text>
    {onContinue && <Pressable accessibilityRole="button" onPress={onContinue} style={styles.button}><Text style={styles.buttonText}>{connected ? "Open workspace" : "Set up Relay"}</Text></Pressable>}
    {children}
  </View>
}

export let AdvancedSetupOptions = () => {
  let router = useRouter()
  let connect = () => router.push({ pathname: "/add-machine", params: { setup: "connect" } })
  let rent = () => router.push({ pathname: "/add-machine", params: { setup: "rent" } })
  let serverGuide = () => { void Linking.openURL("https://clawtab.cc/articles/setup-remote-machines") }
  let relayGuide = () => { void Linking.openURL("https://clawtab.cc/docs#deploy") }
  return <View style={styles.advanced}>
    <Text accessibilityRole="header" style={styles.heading}>Advanced setup</Text>
    <Option title="Connect a machine" detail="Connect the agents and projects on your computer or server." onPress={connect} />
    {Platform.OS === "web" && <Option title="Rent a server" detail="Get a dedicated server with more CPU, memory, and storage." onPress={rent} />}
    <Option title="Install on your server" detail="Install the ClawTab daemon on Linux or Kubernetes." onPress={serverGuide} external />
    <Option title="Host your own relay" detail="Manage the relay infrastructure yourself." onPress={relayGuide} external />
  </View>
}

let InfoButton = ({ label, expanded, onPress }: { label: string; expanded: boolean; onPress: () => void }) => <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={onPress} hitSlop={4} style={styles.infoButton}>
  <Ionicons name="information-circle-outline" size={22} color={colors.textSecondary} />
</Pressable>

let Feature = ({ label, detail, children }: { label: string; detail: string; children: ReactNode }) => {
  let [showInfo, setShowInfo] = useState(false)
  return <View style={styles.option}>
    <View style={styles.header}>
      <Text style={styles.feature}>{children}</Text>
      <InfoButton label={label} expanded={showInfo} onPress={() => setShowInfo((value) => !value)} />
    </View>
    {showInfo && <Text style={styles.detail}>{detail}</Text>}
  </View>
}

let Option = ({ title, detail, onPress, external = false }: { title: string; detail: string; onPress: () => void; external?: boolean }) => {
  let [showInfo, setShowInfo] = useState(false)
  let toggleInfo = () => setShowInfo((value) => !value)
  return <View style={styles.option}>
    <View style={styles.header}>
      <Pressable accessibilityRole={external ? "link" : "button"} onPress={onPress} style={styles.optionAction}>
        <Text style={styles.link}>{title}</Text>
        <Text style={styles.arrow} accessibilityElementsHidden>{external ? "↗" : "›"}</Text>
      </Pressable>
      <InfoButton label={`About: ${title}`} expanded={showInfo} onPress={toggleInfo} />
    </View>
    {showInfo && <Text style={styles.detail}>{detail}</Text>}
  </View>
}

let styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  title: { color: colors.text, fontSize: 24, fontWeight: "600", lineHeight: 32, flex: 1, minWidth: 0 },
  features: { gap: 8 },
  feature: { color: colors.text, fontSize: 15, lineHeight: 23, flex: 1, minWidth: 0 },
  emphasis: { fontWeight: "600" },
  description: { color: colors.textSecondary, fontSize: 15, lineHeight: 23 },
  card: { padding: 20, gap: 16, width: "100%", minWidth: 0, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  heading: { color: colors.text, fontSize: 18, fontWeight: "600", lineHeight: 26 },
  price: { color: colors.text, fontSize: 22, fontWeight: "600" },
  detail: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
  infoButton: { width: 36, height: 36, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  button: { minHeight: 48, width: "100%", minWidth: 0, paddingHorizontal: 16, paddingVertical: 12, alignItems: "center", justifyContent: "center", borderRadius: 999, backgroundColor: colors.accent },
  buttonText: { color: colors.bg, fontSize: 15, fontWeight: "600", flexShrink: 1, textAlign: "center" },
  advanced: { gap: 8, minWidth: 0, paddingTop: 24, borderTopWidth: 1, borderTopColor: colors.border },
  option: { gap: 4, minWidth: 0 },
  optionAction: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48 },
  link: { color: colors.accent, fontSize: 14, fontWeight: "600", flex: 1, minWidth: 0 },
  arrow: { color: colors.textMuted, fontSize: 20 },
})
