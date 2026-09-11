import { ScrollView, StyleSheet } from "react-native"
import { colors } from "@clawtab/shared"
import { MachineSetup } from "../src/components/MachineSetup"

let MachinesScreen = () => <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets><MachineSetup manage /></ScrollView>
export default MachinesScreen

let styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { width: "100%", maxWidth: 840, alignSelf: "center", paddingBottom: 24 },
})
