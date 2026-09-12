import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { BackHandler, Modal, SafeAreaView, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native"
import { colors } from "../theme/colors"

export type MachineOnboardingContent = ReactNode | ((close: () => void) => ReactNode)
export type MachineActionButtonProps = { label: string; onPress: () => void; accessibilityLabel?: string; disabled?: boolean; icon?: "back"; style?: StyleProp<ViewStyle> }
export type MachineModalProps = { title: string; children: ReactNode; onClose: () => void }
export type MachineOnboardingChrome = { renderActionButton: (props: MachineActionButtonProps) => ReactNode; Modal?: import("react").ComponentType<MachineModalProps> }
type Page = { id: number; title: string; content: MachineOnboardingContent }
let OnboardingContext = createContext<{ content?: MachineOnboardingContent; management?: MachineOnboardingContent; chrome?: MachineOnboardingChrome }>({})
let StackContext = createContext<{ push: (page: Omit<Page, "id">) => void } | null>(null)
export let MachineNavigationProvider = StackContext.Provider

export let MachineOnboardingProvider = ({ content, management, chrome, children }: { content?: MachineOnboardingContent; management?: MachineOnboardingContent; chrome?: MachineOnboardingChrome; children: ReactNode }) => {
  let parent = useContext(OnboardingContext)
  return <OnboardingContext.Provider value={{ content: content ?? parent.content, management: management ?? parent.management, chrome: chrome ?? parent.chrome }}>{children}</OnboardingContext.Provider>
}

export let MachineActionButton = (props: MachineActionButtonProps) => {
  let chrome = useContext(OnboardingContext).chrome
  if (chrome) return <>{chrome.renderActionButton(props)}</>
  return <Pressable accessibilityRole="button" accessibilityLabel={props.accessibilityLabel} disabled={props.disabled} onPress={props.onPress} style={[styles.button, props.style]}>
    <Text style={styles.action}>{props.icon === "back" ? "Back" : props.label}</Text>
  </Pressable>
}

// Keep navigation within the presenting modal so native pickers stay in place.
export let MachineModal = (props: MachineModalProps) => {
  let NativeModal = useContext(OnboardingContext).chrome?.Modal
  return NativeModal ? <NativeModal {...props} /> : <FallbackMachineModal {...props} />
}

let FallbackMachineModal = ({ title, children, onClose }: MachineModalProps) => {
  let [pages, setPages] = useState<Page[]>([])
  let nextPage = useRef(0)
  let push = (page: Omit<Page, "id">) => {
    let entry = { ...page, id: ++nextPage.current }
    setPages((current) => [...current, entry])
  }
  let back = () => setPages((current) => current.slice(0, -1))
  let dismiss = pages.length ? back : onClose
  useEffect(() => {
    let subscription = BackHandler.addEventListener("hardwareBackPress", () => { dismiss(); return true })
    return () => subscription.remove()
  }, [dismiss])
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={dismiss}>
    <StackContext.Provider value={{ push }}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          {pages.length > 0 ? <MachineActionButton label="Back" accessibilityLabel="Back" icon="back" onPress={back} /> : <View style={styles.headerSpacer} />}
          <Text style={styles.title}>{pages[pages.length - 1]?.title ?? title}</Text>
          <MachineActionButton label="Done" onPress={onClose} />
        </View>
        <View style={styles.body}>
          <ScrollView style={pages.length > 0 ? styles.hidden : styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>{children}</ScrollView>
          {pages.map((page, index) => <ScrollView key={page.id} style={index === pages.length - 1 ? styles.page : styles.hidden} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            {typeof page.content === "function" ? page.content(onClose) : page.content}
          </ScrollView>)}
        </View>
      </SafeAreaView>
    </StackContext.Provider>
  </Modal>
}

let MachinePageButton = ({ manage = false }: { manage?: boolean }) => {
  let onboarding = useContext(OnboardingContext)
  let stack = useContext(StackContext)
  let content = manage ? onboarding.management : onboarding.content
  let [open, setOpen] = useState(false)
  let close = () => setOpen(false)
  let title = manage ? "Manage machines" : "Add machine"
  let show = () => stack ? stack.push({ title, content }) : setOpen(true)
  if (!content) return null
  return <>
    <MachineActionButton label={manage ? title : "+ Add machine"} onPress={show} />
    {open && <MachineModal title={title} onClose={close}>{typeof content === "function" ? content(close) : content}</MachineModal>}
  </>
}
export let AddMachineButton = () => <MachinePageButton />
export let ManageMachinesButton = () => <MachinePageButton manage />

let styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingTop: 12 },
  body: { flex: 1, minHeight: 0 },
  page: { flex: 1 },
  hidden: { display: "none" },
  content: { width: "100%", maxWidth: 840, alignSelf: "center", paddingBottom: 20 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  title: { flex: 1, color: colors.text, fontSize: 18, fontWeight: "600", textAlign: "center" },
  headerSpacer: { width: 44, height: 44 },
  button: { minHeight: 44, paddingHorizontal: 18, borderRadius: 999, backgroundColor: colors.groupedSurface, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  action: { color: colors.accent, fontSize: 13, fontWeight: "600" },
})
