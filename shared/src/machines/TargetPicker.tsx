import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { colors } from "../theme/colors"
import { MachineIcon, machineAppearance } from "./Appearance"
import { useMachines } from "./client"

export let MachineTargetPicker = ({ target, localMachineId, onSelect }: { target: string | null; localMachineId?: string | null; onSelect: (id: string | null) => void }) => {
  let state = useMachines()
  let local = state.machines.find((machine) => machine.id === localMachineId)
  let options = [
    ...(localMachineId !== undefined ? [{ id: localMachineId, name: local?.name ?? "This desktop", online: true, platform: local?.platform ?? "macos" }] : []),
    ...state.machines.filter((machine) => machine.owned && machine.id !== localMachineId),
  ]
  let select = (id: string | null) => () => onSelect(id)
  return <View style={styles.footer}>
    <Text style={styles.heading}>Run on</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
      {options.map((machine) => <Pressable key={machine.id ?? "local"} accessibilityRole="radio" accessibilityLabel={`Run on ${machine.name}${machine.online ? "" : ", offline"}`} accessibilityState={{ selected: machine.id === target, disabled: !machine.online }} disabled={!machine.online} onPress={select(machine.id)} style={[styles.machine, machine.id === target && styles.selected, !machine.online && styles.offline]}>
        <MachineIcon appearance={machineAppearance({ ...machine, id: machine.id ?? "local" }, state.machineAppearance)} />
        <Text numberOfLines={1} style={styles.name}>{machine.name}</Text>
        {!machine.online && <Text style={styles.status}>Offline</Text>}
      </Pressable>)}
    </ScrollView>
    {!options.length && <Text style={styles.status}>No machine available</Text>}
  </View>
}
let styles = StyleSheet.create({
  footer: { borderTopWidth: 1, borderColor: colors.border, padding: 10, gap: 8 },
  heading: { color: colors.textSecondary, fontSize: 11, fontWeight: "600" },
  row: { gap: 6 },
  machine: { width: 94, minHeight: 64, padding: 8, gap: 6, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: 8 },
  selected: { borderColor: colors.accent, backgroundColor: colors.groupedSurface },
  offline: { opacity: 0.45 },
  name: { color: colors.text, fontSize: 11, maxWidth: "100%" },
  status: { color: colors.textSecondary, fontSize: 10 },
})
