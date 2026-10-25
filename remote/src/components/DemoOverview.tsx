import { ScrollView, StyleSheet, Text, View } from "react-native"
import { colors } from "@clawtab/shared"
import { useSetupProgress } from "../hooks/useSetupProgress"
import { AdvancedSetupOptions, RelayWelcome } from "./RelayWelcome"

export let DemoOverview = ({ onConnect, showSamples = true }: { onConnect: () => void; showSamples?: boolean }) => {
  let { relayComplete } = useSetupProgress()
  return <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent} contentInsetAdjustmentBehavior="automatic">
    <View style={styles.content}>
      <RelayWelcome onContinue={onConnect} connected={relayComplete} />
      {showSamples && <Text style={styles.hint}>Explore the sample agents and terminals. Select Demo to return here.</Text>}
      <AdvancedSetupOptions />
    </View>
  </ScrollView>
}

let styles = StyleSheet.create({
  screen: { flex: 1, minWidth: 0, backgroundColor: colors.bg },
  scrollContent: { flexGrow: 1, padding: 24, paddingBottom: 40 },
  content: { width: "100%", maxWidth: 780, alignSelf: "center", gap: 28 },
  hint: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
})
