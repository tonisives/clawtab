import { useEffect, useMemo, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { colors } from "../theme/colors"
import { saveAccountPreferences, useMachines, type Machine, type MachineAppearance, type PreferencesApi } from "./client"

let ICONS: MachineAppearance["icon"][] = ["desktop", "laptop", "server", "terminal", "chip"]
let PALETTE = ["#8d9fff", "#34b3a0", "#e5a450", "#dc7d9c", "#a78bfa", "#94a3b8"]

export let machineAppearance = (
  machine?: Pick<Machine, "id" | "platform">,
  configured?: Record<string, MachineAppearance>,
  machines: Pick<Machine, "id">[] = [],
): MachineAppearance => {
  let saved = machine && configured?.[machine.id]
  if (saved) return saved
  let orderedIds = machines.map((item) => item.id).sort()
  let index = machine ? orderedIds.indexOf(machine.id) : -1
  if (index < 0) return { icon: machine?.platform === "linux" ? "server" : "desktop", color: machine?.platform === "linux" ? "#34b3a0" : "#8d9fff" }
  return { icon: ICONS[index % ICONS.length], color: PALETTE[Math.floor(index / ICONS.length) % PALETTE.length] }
}

export let MachineIcon = ({ appearance, size = 20 }: { appearance: MachineAppearance; size?: number }) => {
  let iconStyles = useMemo(() => StyleSheet.create({
    frame: { width: size, height: size, justifyContent: "center", alignItems: "center" },
    screen: { width: size * 0.9, height: size * 0.65, borderWidth: 1.5, borderColor: appearance.color, borderRadius: 2 },
    stand: { width: size * 0.4, height: size * 0.16, borderBottomWidth: 1.5, borderColor: appearance.color },
    base: { width: size, borderBottomWidth: 1.5, borderColor: appearance.color, marginTop: 2 },
    rack: { width: size * 0.8, height: size * 0.35, borderWidth: 1.5, borderColor: appearance.color, borderRadius: 2, marginVertical: 1, justifyContent: "center", paddingLeft: 2 },
    dot: { width: 2, height: 2, backgroundColor: appearance.color },
    chip: { width: size * 0.65, height: size * 0.65, borderWidth: 2, borderColor: appearance.color, borderRadius: 2 },
    pins: { width: size * 0.35, height: size, position: "absolute", borderTopWidth: 2, borderBottomWidth: 2, borderColor: appearance.color },
    pinsAcross: { width: size, height: size * 0.35, position: "absolute", borderLeftWidth: 2, borderRightWidth: 2, borderColor: appearance.color },
    terminal: { color: appearance.color, fontSize: size * 0.5, fontWeight: "700", textAlign: "center" },
  }), [appearance.color, size])
  return <View style={iconStyles.frame} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {appearance.icon === "server" ? <><View style={iconStyles.rack}><View style={iconStyles.dot} /></View><View style={iconStyles.rack}><View style={iconStyles.dot} /></View></>
      : appearance.icon === "chip" ? <><View style={iconStyles.pins} /><View style={iconStyles.pinsAcross} /><View style={iconStyles.chip} /></>
      : <><View style={iconStyles.screen}>{appearance.icon === "terminal" && <Text style={iconStyles.terminal}>{">_"}</Text>}</View>{appearance.icon === "desktop" && <View style={iconStyles.stand} />}{appearance.icon === "laptop" && <View style={iconStyles.base} />}</>}
  </View>
}

export let MachineAppearanceEditor = ({ machine, api }: { machine: Machine; api: PreferencesApi }) => {
  let state = useMachines()
  let saved = machineAppearance(machine, state.machineAppearance, state.machines)
  let [icon, setIcon] = useState(saved.icon)
  let [color, setColor] = useState(saved.color)
  let [busy, setBusy] = useState(false)
  let [error, setError] = useState<string | null>(null)
  useEffect(() => { setIcon(saved.icon); setColor(saved.color) }, [saved.icon, saved.color])
  let valid = /^#[0-9a-f]{6}$/i.test(color)
  let preview = { icon, color: valid ? color : saved.color }
  let save = async () => {
    setBusy(true)
    setError(null)
    try { await saveAccountPreferences(api, { machine_id: machine.id, icon, color }) }
    catch { setError("Could not save machine appearance. Try again.") }
    finally { setBusy(false) }
  }
  let pickIcon = (value: MachineAppearance["icon"]) => () => setIcon(value)
  let pickColor = (value: string) => () => setColor(value)
  return <View style={styles.editor}>
    <Text style={styles.label}>Machine appearance</Text>
    <View style={styles.row}>{ICONS.map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`${value} icon`} accessibilityState={{ selected: icon === value }} onPress={pickIcon(value)} style={[styles.option, icon === value && styles.selected]}><MachineIcon appearance={{ ...preview, icon: value }} /></Pressable>)}</View>
    <View style={styles.row}>{PALETTE.map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`Color ${value}`} accessibilityState={{ selected: color === value }} onPress={pickColor(value)} style={[styles.option, color === value && styles.selected]}><MachineIcon appearance={{ icon: "chip", color: value }} /></Pressable>)}</View>
    <View style={styles.row}>
      <TextInput accessibilityLabel="Custom machine color" value={color} onChangeText={setColor} autoCapitalize="none" autoCorrect={false} maxLength={7} style={styles.input} />
      <Pressable accessibilityRole="button" disabled={busy || !valid || (icon === saved.icon && color === saved.color)} onPress={save} style={styles.option}><Text style={styles.label}>{busy ? "Saving…" : "Save appearance"}</Text></Pressable>
    </View>
    <Text style={styles.hint}>Synced to your desktop, web, and mobile apps.</Text>
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </View>
}
let styles = StyleSheet.create({
  editor: { gap: 8, paddingVertical: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  label: { color: colors.text, fontSize: 13 },
  hint: { color: colors.textSecondary, fontSize: 12 },
  error: { color: colors.danger, fontSize: 12 },
  option: { padding: 9, borderWidth: 1, borderColor: colors.border, borderRadius: 8 },
  selected: { borderColor: colors.accent, backgroundColor: colors.groupedSurface },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 9, color: colors.text, width: 100 },
})
