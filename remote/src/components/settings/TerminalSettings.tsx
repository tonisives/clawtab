import { View, Text, Pressable } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTerminalSettings } from "../../store/terminalSettings"
import { colors } from "../../theme/colors"
import { SettingsPage, styles } from "./SettingsPage"

export let TerminalSettings = () => {
  let cachePanes = useTerminalSettings((s) => s.cachePanes)
  let setCachePanes = useTerminalSettings((s) => s.setCachePanes)
  let choose = (count: number) => () => setCachePanes(count)
  return <SettingsPage>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Terminal cache</Text>
      <Text style={styles.cacheDescription}>Show recent pane contents immediately while reconnecting. Kept in memory on this device.</Text>
      <View style={styles.listGroup}>
        {[0, 5, 10].map((count) => <Pressable key={count} onPress={choose(count)} accessibilityRole="radio" accessibilityState={{ checked: cachePanes === count }} style={styles.row}>
          <Text style={styles.rowTitle}>{count === 0 ? "Off" : `${count} panes`}</Text>
          {cachePanes === count && <Ionicons name="checkmark" size={22} color={colors.accent} />}
        </Pressable>)}
      </View>
    </View>
  </SettingsPage>
}
