import { useEffect, useRef } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { Stack, useLocalSearchParams, useRouter } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { XtermLog, JobKindIcon, colors, kindForProcess, type XtermLogHandle } from "@clawtab/shared"
import { HeaderTitleWithIcon } from "../src/components/HeaderButtons"
import { DEMO_JOBS, DEMO_LOGS, DEMO_PROCESSES } from "../src/demo/data"

let DemoAgentScreen = () => {
  let { id, kind } = useLocalSearchParams<{ id: string; kind?: string }>()
  let router = useRouter()
  let terminal = useRef<XtermLogHandle | null>(null)
  let process = kind === "process" ? DEMO_PROCESSES.find((item) => item.pane_id === id) : undefined
  let job = kind === "job" ? DEMO_JOBS.find((item) => item.slug === id) : undefined
  let title = process?.display_name ?? job?.display_name ?? job?.name ?? "Sample agent"
  let output = process?.log_lines ?? (job ? DEMO_LOGS[job.slug] : "Sample not found.")
  useEffect(() => {
    terminal.current?.clear()
    terminal.current?.writeText(output ?? "")
  }, [output])
  let openDetails = () => router.push({ pathname: "/demo-agent-details", params: { id, kind } })
  let headerTitle = () => <HeaderTitleWithIcon title={title} icon={<JobKindIcon kind={process ? kindForProcess(process) : "shell"} size={26} bare />} onPress={openDetails} accessibilityLabel="Open pane overview" />
  let headerRight = () => <Pressable accessibilityRole="button" accessibilityLabel="Open pane overview" onPress={openDetails} style={styles.menu} hitSlop={8}><Ionicons name="ellipsis-horizontal" size={22} color={colors.text} /></Pressable>
  return <View style={styles.screen}>
    <Stack.Screen options={{ title, headerTitle, headerRight }} />
    <Text style={styles.notice}>Demo</Text>
    <View style={styles.terminal} accessibilityLabel="Shell logs"><XtermLog ref={terminal} interactive={false} /></View>
  </View>
}
export default DemoAgentScreen

let styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  terminal: { flex: 1, backgroundColor: "#1c1c1e" },
  notice: { color: colors.textSecondary, fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 },
  menu: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
})
