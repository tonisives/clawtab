import { useRef, useState } from "react"
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context"
import { Ionicons } from "@expo/vector-icons"
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect"
import { MachineNavigationProvider, colors, type MachineModalProps, type MachineOnboardingContent } from "@clawtab/shared"

type Page = { id: number; title: string; content: MachineOnboardingContent }

let SheetIconButton = ({ icon, label, onPress }: { icon: "close" | "chevron-back"; label: string; onPress: () => void }) => {
  let glassAvailable = false
  try { glassAvailable = isGlassEffectAPIAvailable() } catch {}
  return <View style={styles.iconFrame}>
    {glassAvailable && <GlassView pointerEvents="none" glassEffectStyle="regular" colorScheme="dark" style={[StyleSheet.absoluteFill, styles.iconGlass]} />}
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
      <Ionicons name={icon} size={22} color={colors.text} />
    </Pressable>
  </View>
}

export let MachineNavigationModal = ({ title, children, overlay, onClose }: MachineModalProps) => {
  let [pages, setPages] = useState<Page[]>([])
  let nextPage = useRef(0)
  let push = (page: Omit<Page, "id">) => {
    let entry = { ...page, id: ++nextPage.current }
    setPages((current) => [...current, entry])
  }
  let back = () => setPages((current) => current.slice(0, -1))
  let currentPage = pages[pages.length - 1]
  let dismiss = currentPage ? back : onClose
  // Keep one native modal touch surface; child pages share its React view tree.
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={dismiss}>
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <MachineNavigationProvider value={{ push }}>
          <View style={styles.header}>
            {currentPage ? <SheetIconButton icon="chevron-back" label="Back" onPress={back} /> : <View style={styles.iconFrame} />}
            <Text style={styles.title} numberOfLines={1}>{currentPage?.title ?? title}</Text>
            <SheetIconButton icon="close" label={`Close ${title.toLowerCase()}`} onPress={onClose} />
          </View>
          <View style={styles.body}>
            <ScrollView style={currentPage ? styles.hidden : styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>{children}</ScrollView>
            {pages.map((page) => <ScrollView key={page.id} style={page === currentPage ? styles.screen : styles.hidden} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
              {typeof page.content === "function" ? page.content(onClose) : page.content}
            </ScrollView>)}
          </View>
          {overlay}
        </MachineNavigationProvider>
      </SafeAreaView>
    </SafeAreaProvider>
  </Modal>
}

let styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, minHeight: 0 },
  hidden: { display: "none" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  title: { flex: 1, color: colors.text, fontSize: 18, fontWeight: "600", textAlign: "center" },
  content: { width: "100%", maxWidth: 840, alignSelf: "center", paddingBottom: 24 },
  iconFrame: { width: 44, height: 44, borderRadius: 22, overflow: "hidden" },
  iconGlass: { borderRadius: 22 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.6 },
})
