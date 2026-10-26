import { Pressable, StyleSheet, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { colors } from "@clawtab/shared"
import { useAuthStore } from "../src/store/auth"
import { AdvancedSetupOptions, RelayWelcome } from "../src/components/RelayWelcome"
import { RelaySubscription } from "../src/components/settings/RelaySubscription"
import { SettingsButton, SettingsPage } from "../src/components/settings/SettingsPage"

export default function WorkspaceScreen() {
  let router = useRouter()
  let authenticated = useAuthStore((state) => state.isAuthenticated)
  let signIn = () => router.push({ pathname: "/login", params: { return_to: "workspace" } })
  let openAccount = () => router.push("/account")
  return <SettingsPage>
    {authenticated && <SettingsButton title="Account settings" onPress={openAccount} />}
    {authenticated ? <RelaySubscription /> : <RelayWelcome><View style={styles.signIn}>
      <Pressable accessibilityRole="button" onPress={signIn} style={styles.button}><Text style={styles.action}>Sign in</Text></Pressable>
    </View></RelayWelcome>}
    <AdvancedSetupOptions />
  </SettingsPage>
}

let styles = StyleSheet.create({
  signIn: { minWidth: 0, width: "100%" },
  button: { minHeight: 48, width: "100%", minWidth: 0, paddingHorizontal: 16, paddingVertical: 12, alignItems: "center", justifyContent: "center", borderRadius: 999, backgroundColor: colors.accent },
  action: { color: colors.bg, fontSize: 15, fontWeight: "600", flexShrink: 1, textAlign: "center" },
})
