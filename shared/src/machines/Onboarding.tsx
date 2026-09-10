import { createContext, useContext, useState, type ReactNode } from "react"
import { Modal, SafeAreaView, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
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
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>Add machine</Text>
          <Pressable accessibilityRole="button" onPress={close} style={styles.button}><Text style={styles.action}>Done</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{typeof content === "function" ? content(close) : content}</ScrollView>
      </SafeAreaView>
    </Modal>}
  </>
}

let styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingTop: 12 },
  content: { width: "100%", maxWidth: 840, alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  button: { minHeight: 44, paddingHorizontal: 18, borderRadius: 999, backgroundColor: colors.groupedSurface, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  action: { color: colors.accent, fontSize: 13, fontWeight: "600" },
})
