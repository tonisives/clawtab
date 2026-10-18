import { useEffect, useRef, useState } from "react"
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { useHeaderHeight } from "expo-router/react-navigation"
import { SafeAreaView } from "react-native-safe-area-context"
import { Stack, useLocalSearchParams, useRouter } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { XtermLog, JobKindIcon, colors, kindForProcess, type XtermLogHandle } from "@clawtab/shared"
import { HeaderTitleWithIcon } from "../src/components/HeaderButtons"
import { DEMO_JOBS, DEMO_LOGS, DEMO_PROCESSES } from "../src/demo/data"
import { demoShell } from "../src/demo/shell"
import { showDemoInfo } from "../src/demo/info"

let DemoAgentScreen = () => {
  let { id, kind } = useLocalSearchParams<{ id: string; kind?: string }>()
  let router = useRouter()
  let terminal = useRef<XtermLogHandle | null>(null)
  let input = useRef<TextInput | null>(null)
  let [draft, setDraft] = useState("")
  let headerHeight = useHeaderHeight()
  let process = kind === "process" ? DEMO_PROCESSES.find((item) => item.pane_id === id) : undefined
  let job = kind === "job" ? DEMO_JOBS.find((item) => item.slug === id) : undefined
  let title = process?.display_name ?? job?.display_name ?? job?.name ?? "Sample agent"
  let output = process?.log_lines ?? (job ? DEMO_LOGS[job.slug] : "Sample not found.")
  let provider = process?.provider ?? job?.agent_provider ?? (job?.job_type === "claude" ? "claude" : undefined)
  let shell = demoShell(output ?? "", provider)
  useEffect(() => {
    setDraft("")
    terminal.current?.clear()
    terminal.current?.writeText(shell.output)
  }, [shell.output])
  let focusInput = () => input.current?.focus()
  let dismissInput = () => input.current?.blur()
  let openDetails = () => router.push({ pathname: "/demo-agent-details", params: { id, kind } })
  let headerTitle = () => <HeaderTitleWithIcon title={title} icon={<JobKindIcon kind={process ? kindForProcess(process) : "shell"} size={26} bare />} onPress={openDetails} accessibilityLabel="Open pane overview" />
  let headerRight = () => <Pressable accessibilityRole="button" accessibilityLabel="Open pane overview" onPress={openDetails} style={styles.menu} hitSlop={8}><Ionicons name="ellipsis-horizontal" size={22} color={colors.text} /></Pressable>
  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
    <Stack.Screen options={{ title, headerTitle, headerRight }} />
    <Pressable style={styles.notice} accessibilityRole="button" accessibilityLabel="About demo mode" onPress={showDemoInfo}><Ionicons name="alert-circle-outline" size={18} color={colors.warning} /><Text style={styles.noticeText}>Demo</Text></Pressable>
    <View style={styles.terminal} accessibilityLabel="Shell logs"><XtermLog ref={terminal} interactive={false} forceDarkTheme extendedViewport /></View>
    <SafeAreaView edges={["bottom"]} style={styles.composer}>
      <TextInput ref={input} value={draft} onChangeText={setDraft} placeholder={shell.placeholder} placeholderTextColor="#a1a1aa" accessibilityLabel="Demo prompt" accessibilityHint="Try typing locally. Demo prompts are not sent to an agent." multiline submitBehavior="blurAndSubmit" blurOnSubmit onSubmitEditing={dismissInput} returnKeyType="done" autoCapitalize="none" autoCorrect={false} style={styles.input} />
      <View style={styles.inputFooter}><Text style={styles.model}>{shell.model}</Text><Pressable accessibilityRole="button" accessibilityLabel="Show keyboard" onPress={focusInput} style={styles.menu}><Ionicons name="keypad-outline" size={22} color="#a1a1aa" /></Pressable></View>
    </SafeAreaView>
  </KeyboardAvoidingView>
}
export default DemoAgentScreen

let styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  terminal: { flex: 1, minHeight: 0, backgroundColor: "#1c1c1e" },
  notice: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 12 },
  noticeText: { color: colors.warning, fontSize: 13 },
  composer: { backgroundColor: "#252528", paddingHorizontal: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#48484a" },
  input: { color: "#e4e4e4", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 14, minHeight: 52, maxHeight: 120, paddingTop: 16, paddingBottom: 8, textAlignVertical: "top" },
  inputFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  model: { color: "#a1a1aa", fontSize: 12, flex: 1 },
  menu: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
})
