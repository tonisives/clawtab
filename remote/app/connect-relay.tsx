import { useState } from "react"
import { Linking, Pressable, StyleSheet, Text, TextInput } from "react-native"
import { useRouter } from "expo-router"
import { colors } from "@clawtab/shared"
import { normalizeRelayUrl, setServerUrl } from "../src/api/client"
import { useAuthStore } from "../src/store/auth"
import { SettingsButton, SettingsPage } from "../src/components/settings/SettingsPage"

export default function ConnectRelayScreen() {
  let router = useRouter()
  let [url, setUrl] = useState("")
  let [busy, setBusy] = useState(false)
  let [error, setError] = useState("")
  let connect = async () => {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      const relayUrl = normalizeRelayUrl(url)
      await useAuthStore.getState().logout()
      await setServerUrl(relayUrl)
      router.replace({ pathname: "/login", params: { return_to: "machines" } })
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not connect to this relay.")
    } finally { setBusy(false) }
  }
  return <SettingsPage>
    <Text style={styles.description}>Enter the URL of the relay you set up, then sign in to it.</Text>
    <Pressable accessibilityRole="link" onPress={() => { void Linking.openURL("https://clawtab.cc/docs#deploy") }} style={styles.guide}>
      <Text style={styles.guideText}>How to host your own relay</Text>
    </Pressable>
    <TextInput accessibilityLabel="Relay URL" placeholder="https://relay.example.com" placeholderTextColor={colors.textMuted} value={url} onChangeText={setUrl} editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" onSubmitEditing={connect} style={styles.input} />
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <SettingsButton title={busy ? "Connecting..." : "Continue"} onPress={connect} disabled={busy || !url.trim()} variant="primary" />
  </SettingsPage>
}

let styles = StyleSheet.create({
  description: { color: colors.textSecondary, fontSize: 15, lineHeight: 23 },
  guide: { minHeight: 44, justifyContent: "center" },
  guideText: { color: colors.accent, fontSize: 14, lineHeight: 20 },
  input: { color: colors.text, fontSize: 16, minHeight: 48, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
})
