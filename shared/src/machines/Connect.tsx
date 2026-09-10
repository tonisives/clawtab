import { useRef, useState } from "react"
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { colors } from "../theme/colors"

type Props = { approvePairing: (code: string) => Promise<unknown>; initiallyExpanded?: boolean }

export let ConnectMachine = ({ approvePairing, initiallyExpanded = false }: Props) => {
  let [expanded, setExpanded] = useState(initiallyExpanded)
  let [instructions, setInstructions] = useState(false)
  let [code, setCode] = useState("")
  let [busy, setBusy] = useState(false)
  let pending = useRef(false)
  let [error, setError] = useState<string | null>(null)
  let [approved, setApproved] = useState(false)
  let toggle = () => setExpanded(!expanded)
  let toggleInstructions = () => setInstructions(!instructions)
  let approve = async () => {
    if (pending.current || !code.trim()) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      await approvePairing(code.trim())
      setCode("")
      setApproved(true)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not connect this machine")
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  let editCode = (value: string) => { setCode(value); setApproved(false) }
  let openGuide = () => {
    void Linking.openURL("https://clawtab.cc/articles/setup-remote-machines").catch(() => setError("Could not open the setup guide"))
  }
  return <View style={styles.card}>
    <Text style={styles.title}>Use your own machine</Text>
    <Text style={styles.detail}>Connect a Linux server you already have.</Text>
    {!expanded ? <Pressable accessibilityRole="button" onPress={toggle} style={styles.button}>
      <Text style={styles.buttonText}>Connect machine</Text>
    </Pressable> : <>
      <TextInput accessibilityLabel="Pairing code" placeholder="Pairing code" placeholderTextColor={colors.textSecondary}
        value={code} onChangeText={editCode} autoCapitalize="characters" autoCorrect={false}
        editable={!busy} onSubmitEditing={approve} returnKeyType="go" style={styles.input} />
      <Pressable accessibilityRole="button" disabled={busy || !code.trim()} accessibilityState={{ disabled: busy || !code.trim() }}
        onPress={approve} style={[styles.button, (busy || !code.trim()) && styles.disabled]}>
        <Text style={styles.buttonText}>{busy ? "Connecting…" : "Connect machine"}</Text>
      </Pressable>
      {approved && <Text accessibilityLiveRegion="polite" style={styles.detail}>Machine approved. Keep setup running on your server until it connects.</Text>}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: instructions }} onPress={toggleInstructions} style={styles.help}>
        <Text style={styles.detail}>{instructions ? "Hide instructions" : "Where do I get a pairing code?"}</Text>
      </Pressable>
      {instructions && <View style={styles.instructions}>
        <Text style={styles.detail}>Install ClawTab on your Linux server, then run:</Text>
        <Text selectable style={styles.command}>cwtctl setup</Text>
        <Text style={styles.detail}>Leave it running and enter the code shown above.</Text>
        <Pressable accessibilityRole="link" onPress={openGuide} style={styles.help}><Text style={styles.link}>Linux setup guide</Text></Pressable>
      </View>}
    </>}
  </View>
}

let styles = StyleSheet.create({
  card: { margin: 16, marginTop: 0, padding: 16, gap: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16 },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  detail: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  button: { borderRadius: 999, backgroundColor: colors.accentBg, borderColor: colors.accent, borderWidth: 1, paddingHorizontal: 20, minHeight: 44, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  input: { color: colors.text, borderColor: colors.borderLight, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 16 },
  help: { minHeight: 44, justifyContent: "center" },
  instructions: { gap: 8 },
  command: { color: colors.text, fontFamily: "monospace", padding: 12, backgroundColor: colors.groupedSurface, borderRadius: 8 },
  link: { color: colors.accent, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
})
