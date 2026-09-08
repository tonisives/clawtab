import { Text, StyleSheet } from "react-native"
import { useMachines } from "./client"
export let MachineBadge = ({ machineId }: { machineId?: string }) => {
  let state = useMachines()
  if (!machineId) return null
  let machine = state.machines.find((item) => item.id === machineId)
  return (
    <Text style={styles.badge}>
      {machine?.name ?? "Machine"}
      {machine?.online ? "" : " · offline"}
    </Text>
  )
}
let styles = StyleSheet.create({ badge: { color: "#989ca6", fontSize: 11, paddingHorizontal: 5 } })
