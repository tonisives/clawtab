import { useEffect, useMemo, useState } from "react"
import { Modal, Pressable, StyleSheet, Text, TextInput, View, type GestureResponderEvent } from "react-native"
import { colors } from "../theme/colors"
import { saveAccountPreferences, useMachines, type Machine, type MachineAppearance, type PreferencesApi } from "./client"

let ICONS: MachineAppearance["icon"][] = ["desktop", "laptop", "server", "terminal", "chip"]
let PALETTE = ["#8d9fff", "#34b3a0", "#e5a450", "#dc7d9c", "#a78bfa", "#94a3b8"]

let defaultIcon = (platform?: string): MachineAppearance["icon"] =>
  platform === "linux" ? "server" : platform === "macos" ? "desktop" : "laptop"

let defaultColor = (index: number) => {
  if (index < PALETTE.length) return PALETTE[index]
  let hue = (index * 137.508) % 360
  let lightness = 0.7
  let chroma = 0.65 * Math.min(lightness, 1 - lightness)
  let channel = (offset: number) => {
    let position = (offset + hue / 30) % 12
    let value = lightness - chroma * Math.max(-1, Math.min(position - 3, 9 - position, 1))
    return Math.round(value * 255).toString(16).padStart(2, "0")
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

export let machineAppearance = (
  machine?: Pick<Machine, "id" | "platform">,
  configured?: Record<string, MachineAppearance>,
  machines: Pick<Machine, "id">[] = [],
): MachineAppearance => {
  let saved = machine && configured?.[machine.id]
  if (saved) return saved
  let orderedIds = machines.map((item) => item.id).sort()
  let index = machine ? orderedIds.indexOf(machine.id) : -1
  return { icon: defaultIcon(machine?.platform), color: defaultColor(Math.max(0, index)) }
}

export let MachineIcon = ({ appearance, size = 20, strokeWidth = 1.5 }: { appearance: MachineAppearance; size?: number; strokeWidth?: number }) => {
  let iconStyles = useMemo(() => StyleSheet.create({
    frame: { width: size, height: size, justifyContent: "center", alignItems: "center" },
    screen: { width: size * 0.9, height: size * 0.65, borderWidth: strokeWidth, borderColor: appearance.color, borderRadius: 2 },
    stand: { width: size * 0.4, height: size * 0.16, borderBottomWidth: strokeWidth, borderColor: appearance.color },
    base: { width: size, borderBottomWidth: strokeWidth, borderColor: appearance.color, marginTop: 2 },
    tower: { width: size * 0.65, height: size * 0.95, borderWidth: strokeWidth, borderColor: appearance.color, borderRadius: 2, justifyContent: "space-evenly", alignItems: "center" },
    slot: { width: size * 0.38, borderBottomWidth: strokeWidth, borderColor: appearance.color },
    lights: { width: size * 0.38, flexDirection: "row", justifyContent: "flex-end", gap: 2 },
    dot: { width: strokeWidth, height: strokeWidth, backgroundColor: appearance.color },
    chip: { width: size * 0.65, height: size * 0.65, borderWidth: strokeWidth, borderColor: appearance.color, borderRadius: 2 },
    pins: { width: size * 0.35, height: size, position: "absolute", borderTopWidth: strokeWidth, borderBottomWidth: strokeWidth, borderColor: appearance.color },
    pinsAcross: { width: size, height: size * 0.35, position: "absolute", borderLeftWidth: strokeWidth, borderRightWidth: strokeWidth, borderColor: appearance.color },
    terminal: { color: appearance.color, fontSize: size * 0.5, fontWeight: "700", textAlign: "center" },
  }), [appearance.color, size, strokeWidth])
  return <View style={iconStyles.frame} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {appearance.icon === "server" ? <View style={iconStyles.tower}><View style={iconStyles.slot} /><View style={iconStyles.slot} /><View style={iconStyles.lights}><View style={iconStyles.dot} /><View style={iconStyles.dot} /></View></View>
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
export let MachineAppearanceButton = ({ machine, api }: { machine: Machine; api: PreferencesApi }) => {
  let state = useMachines()
  let [open, setOpen] = useState(false)
  let show = () => setOpen(true)
  let close = () => setOpen(false)
  let keepOpen = (event: GestureResponderEvent) => event.stopPropagation()
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`Edit appearance of ${machine.name}`} onPress={show} style={styles.appearanceButton}>
      <MachineIcon appearance={machineAppearance(machine, state.machineAppearance, state.machines)} size={18} />
      <Text style={styles.label}>Machine appearance</Text>
    </Pressable>
    {open && <Modal visible transparent animationType="fade" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable accessibilityViewIsModal style={styles.dialog} onPress={keepOpen}>
          <View style={styles.header}>
            <View style={styles.heading}><Text style={styles.title}>Machine appearance</Text><Text style={styles.hint}>{machine.name}</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close machine appearance" onPress={close} style={styles.closeButton}><Text style={styles.closeText}>Close</Text></Pressable>
          </View>
          <MachineAppearanceEditor machine={machine} api={api} />
        </Pressable>
      </Pressable>
    </Modal>}
  </>
}
let styles = StyleSheet.create({
  appearanceButton: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", minHeight: 44, paddingHorizontal: 12, marginVertical: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 999 },
  backdrop: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20, backgroundColor: "rgba(0, 0, 0, 0.58)" },
  dialog: { width: "100%", maxWidth: 440, padding: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  heading: { flex: 1, gap: 4 },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  closeButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center" },
  closeText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  editor: { gap: 8, paddingVertical: 12 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  label: { color: colors.text, fontSize: 13 },
  hint: { color: colors.textSecondary, fontSize: 12 },
  error: { color: colors.danger, fontSize: 12 },
  option: { padding: 9, borderWidth: 1, borderColor: colors.border, borderRadius: 8 },
  selected: { borderColor: colors.accent, backgroundColor: colors.groupedSurface },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 9, color: colors.text, width: 100 },
})
