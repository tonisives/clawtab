import { createContext, useContext, useState, type ReactNode } from "react"
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { colors } from "../theme/colors"

export type MachineOnboardingContent = ReactNode | ((close: () => void) => ReactNode)
let OnboardingContext = createContext<MachineOnboardingContent>(null)

export let MachineOnboardingProvider = ({ content, children }: { content?: MachineOnboardingContent; children: ReactNode }) => (
  <OnboardingContext.Provider value={content}>{children}</OnboardingContext.Provider>
)

export let AddMachineButton = () => {
  let content = useContext(OnboardingContext)
  let [open, setOpen] = useState(false)
  let close = () => setOpen(false)
  if (!content) return null
  // Keep this modal inside its triggering picker: native agent pickers already
  // present a modal, so machine setup must be presented from that view.
  return <>
    <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={styles.button}><Text style={styles.action}>+ Add machine</Text></Pressable>
    {open && <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>Add machine</Text>
          <Pressable accessibilityRole="button" onPress={close} style={styles.button}><Text style={styles.action}>Done</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{typeof content === "function" ? content(close) : content}</ScrollView>
      </View>
    </Modal>}
  </>
}

let styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingTop: 20 },
  content: { width: "100%", maxWidth: 840, alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  button: { padding: 12, justifyContent: "center" },
  action: { color: colors.accent, fontSize: 13, fontWeight: "600" },
})
