import { Text, View, StyleSheet } from "react-native"
import { useMachines } from "./client"
import { MachineIcon, machineAppearance } from "./Appearance"
export let MachineBadge = ({ machineId }: { machineId?: string }) => {
  let state = useMachines()
  if (!machineId) return null
  let machine = state.machines.find((item) => item.id === machineId)
  return (
    <View style={styles.row}>
      <MachineIcon size={14} appearance={machineAppearance(machine, state.machineAppearance)} />
      <Text style={styles.badge}>
      {machine?.name ?? "Machine"}
      {machine?.online ? "" : " · offline"}
      </Text>
    </View>
  )
}
let styles = StyleSheet.create({ row: { flexDirection: "row", alignItems: "center", gap: 4 }, badge: { color: "#989ca6", fontSize: 11, paddingHorizontal: 5 } })
