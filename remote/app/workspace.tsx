import { Pressable, StyleSheet, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { colors } from "@clawtab/shared"
import { useAuthStore } from "../src/store/auth"
import { AdvancedSetupOptions, RelayWelcome } from "../src/components/RelayWelcome"
import { RelaySubscription } from "../src/components/settings/RelaySubscription"
import { SettingsPage } from "../src/components/settings/SettingsPage"

export default function WorkspaceScreen() {
  let router = useRouter()
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  let signIn = () => router.push({ pathname: "/login", params: { return_to: "workspace" } })
  return <SettingsPage>
    {authenticated ? <RelaySubscription onboarding /> : <RelayWelcome><View style={styles.signIn}>
      <Text style={styles.detail}>Sign in to subscribe to Relay or open your included workspace.</Text>
      <Pressable accessibilityRole="button" onPress={signIn} style={styles.button}><Text style={styles.action}>Sign in to get started</Text></Pressable>
    </View></RelayWelcome>}
    <AdvancedSetupOptions />
  </SettingsPage>
}

let styles = StyleSheet.create({
  signIn: { gap: 16 },
  detail: { color: colors.textSecondary, fontSize: 14, lineHeight: 22 },
  button: { minHeight: 48, paddingHorizontal: 24, alignSelf: "flex-start", alignItems: "center", justifyContent: "center", borderRadius: 999, backgroundColor: colors.accent },
  action: { color: colors.bg, fontSize: 15, fontWeight: "600" },
})
