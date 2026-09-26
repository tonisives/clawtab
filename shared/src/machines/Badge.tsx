import { Text, View, StyleSheet } from "react-native"
import { useMachines } from "./client"
import { MachineIcon, machineAppearance } from "./Appearance"
export let MachineBadge = ({ machineId, compact = false }: { machineId?: string; compact?: boolean }) => {
  let state = useMachines()
  if (!machineId) return null
  let machine = state.machines.find((item) => item.id === machineId)
  let appearance = machineAppearance(machine, state.machineAppearance, state.machines)
  return (
    <View style={styles.row} accessibilityLabel={machine?.name ?? "Machine"}>
      <MachineIcon size={compact ? 18 : 14} appearance={appearance} />
      {!compact && <Text style={[styles.badge, { color: appearance.color }]}>
      {machine?.name ?? "Machine"}
      {machine?.online ? "" : " · offline"}
      </Text>}
    </View>
  )
}
export let MachineMark = ({ machineId }: { machineId?: string }) => {
  let state = useMachines()
  if (!machineId) return null
  let machine = state.machines.find((item) => item.id === machineId)
  return <MachineIcon size={10} strokeWidth={1} appearance={machineAppearance(machine, state.machineAppearance, state.machines)} />
}
let styles = StyleSheet.create({ row: { flexDirection: "row", alignItems: "center", gap: 4 }, badge: { color: "#989ca6", fontSize: 11, paddingHorizontal: 5 } })
