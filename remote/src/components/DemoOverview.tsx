import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { colors } from "@clawtab/shared"

export let DemoOverview = ({ onConnect }: { onConnect: () => void }) => {
  let router = useRouter()
  let rent = () => router.push("/add-machine")
  return <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
    <View style={styles.content}>
      <Text style={styles.eyebrow}>DEMO MODE</Text>
      <Text style={styles.title}>Try ClawTab with sample agents</Text>
      <Text style={styles.description}>Explore the jobs and agent terminals in the sidebar. These are sample sessions: prompts stay on this device and agent actions are disabled.</Text>
      <Text style={styles.heading}>Ready to run your own agents?</Text>
      <View style={styles.options}>
        {Platform.OS === "web" && <View style={styles.card}>
          <Text style={styles.cardTitle}>Rent a box</Text>
          <Text style={styles.description}>Get a cloud machine with ClawTab and coding agents installed. Relay access is included. Sign in with your own AI accounts.</Text>
          <Pressable accessibilityRole="button" onPress={rent} style={styles.button}><Text style={styles.buttonText}>Choose a box</Text></Pressable>
        </View>}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Connect your own machine</Text>
          <Text style={styles.description}>Subscribe to relay, then connect your local machine or server to access your live agents from iOS and the web.</Text>
          <Pressable accessibilityRole="button" onPress={onConnect} style={styles.button}><Text style={styles.buttonText}>Subscribe to relay</Text></Pressable>
        </View>
      </View>
      <Text style={styles.hint}>Select a job or agent to explore. Select Demo to return here.</Text>
    </View>
  </ScrollView>
}

let styles = StyleSheet.create({
  screen: { flex: 1, minWidth: 0, backgroundColor: colors.bg },
  scrollContent: { flexGrow: 1, justifyContent: "center", padding: 28 },
  content: { width: "100%", maxWidth: 880, alignSelf: "center", gap: 20 },
  eyebrow: { color: colors.warning, fontSize: 12, fontWeight: "600", letterSpacing: 1.4 },
  title: { color: colors.text, fontSize: 30, fontWeight: "600", lineHeight: 38 },
  description: { color: colors.textSecondary, fontSize: 15, lineHeight: 23 },
  heading: { color: colors.text, fontSize: 18, fontWeight: "600", marginTop: 12 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  card: { flexGrow: 1, flexBasis: 280, gap: 16, padding: 24, backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: colors.border },
  cardTitle: { color: colors.text, fontSize: 20, fontWeight: "600" },
  button: { minHeight: 44, paddingHorizontal: 20, paddingVertical: 12, marginTop: "auto", alignItems: "center", justifyContent: "center", borderRadius: 999, backgroundColor: colors.accentBg, borderWidth: 1, borderColor: colors.accent },
  buttonText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  hint: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
})
