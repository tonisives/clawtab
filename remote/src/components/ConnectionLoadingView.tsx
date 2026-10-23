import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native"
import { reconnectMachines, colors } from "@clawtab/shared"

export let ConnectionLoadingView = ({ label, error, onAccount }: { label: string; error?: string | null; onAccount?: () => void }) => <View style={styles.container}>
  {!error && <ActivityIndicator color={colors.accent} />}
  <Text accessibilityLiveRegion="polite" style={styles.label}>{error ? "Unable to connect to relay" : label}</Text>
  {error && <>
    <Text style={styles.detail}>{error}</Text>
    <Pressable accessibilityRole="button" onPress={reconnectMachines} style={styles.button}><Text style={styles.action}>Try again</Text></Pressable>
    {onAccount && <Pressable accessibilityRole="button" onPress={onAccount} style={styles.button}><Text style={styles.action}>Account & subscription</Text></Pressable>}
  </>}
</View>

let styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16, backgroundColor: colors.bg },
  label: { color: colors.text, fontSize: 16 },
  detail: { color: colors.textSecondary, fontSize: 14, lineHeight: 21, textAlign: "center" },
  button: { minHeight: 44, paddingHorizontal: 20, justifyContent: "center" },
  action: { color: colors.accent, fontSize: 14, fontWeight: "600" },
})
