import { useEffect, useRef, useState } from "react"
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { JobKindIcon, XtermLog, colors, kindForProcess, type XtermLogHandle } from "@clawtab/shared"
import { MachineModal } from "../../../shared/src/machines/Onboarding"
import { DEMO_JOBS, DEMO_LOGS, DEMO_PROCESSES } from "../demo/data"
import { demoShell } from "../demo/shell"
import { DemoDetailsContent } from "./DemoDetailsContent"

export type DemoSelection = { id: string; kind: "job" | "process" }

export let DemoAgentPane = ({ id, kind, onShowOverview }: DemoSelection & { onShowOverview: () => void }) => {
  let terminal = useRef<XtermLogHandle | null>(null)
  let [draft, setDraft] = useState("")
  let [detailsOpen, setDetailsOpen] = useState(false)
  let process = kind === "process" ? DEMO_PROCESSES.find((item) => item.pane_id === id) : undefined
  let job = kind === "job" ? DEMO_JOBS.find((item) => item.slug === id) : undefined
  let title = process?.display_name ?? job?.display_name ?? job?.name ?? "Sample agent"
  let output = process?.log_lines ?? (job ? DEMO_LOGS[job.slug] : "Sample not found.")
  let provider = process?.provider ?? job?.agent_provider ?? (job?.job_type === "claude" ? "claude" : undefined)
  let shell = demoShell(output ?? "", provider)
  useEffect(() => {
    setDraft("")
    setDetailsOpen(false)
    terminal.current?.clear()
    terminal.current?.writeText(shell.output)
  }, [id, kind, shell.output])
  let openDetails = () => setDetailsOpen(true)
  let closeDetails = () => setDetailsOpen(false)
  return <View style={styles.screen}>
    <View style={styles.header}>
      <JobKindIcon kind={process ? kindForProcess(process) : "shell"} size={24} bare />
      <Text style={styles.title} numberOfLines={1}>{title}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="About demo mode" onPress={onShowOverview} style={styles.demoButton}>
        <Ionicons name="information-circle-outline" size={18} color={colors.warning} />
        <Text style={styles.demo}>Demo</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Agent details" onPress={openDetails} style={styles.menu}>
        <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
      </Pressable>
    </View>
    <View style={styles.terminal} accessibilityLabel="Shell logs"><XtermLog ref={terminal} interactive={false} forceDarkTheme /></View>
    <View style={styles.composer}>
      <TextInput value={draft} onChangeText={setDraft} placeholder={shell.placeholder} placeholderTextColor={colors.textMuted} accessibilityLabel="Demo prompt" accessibilityHint="Try typing locally. Demo prompts are not sent to an agent." multiline autoCapitalize="none" autoCorrect={false} style={styles.input} />
      <Text style={styles.model}>{shell.model}</Text>
    </View>
    {detailsOpen && <MachineModal title="Agent details" onClose={closeDetails}><DemoDetailsContent id={id} kind={kind} onShowOverview={onShowOverview} /></MachineModal>}
  </View>
}

let styles = StyleSheet.create({
  screen: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: colors.bg },
  header: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { flex: 1, minWidth: 0, color: colors.text, fontSize: 16, fontWeight: "600" },
  demo: { color: colors.warning, fontSize: 12 },
  demoButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6 },
  menu: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  terminal: { flex: 1, minHeight: 0 },
  composer: { backgroundColor: colors.surface, padding: 16, gap: 8, borderTopWidth: 1, borderTopColor: colors.border },
  input: { color: colors.text, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 14, minHeight: 52, maxHeight: 120, textAlignVertical: "top" },
  model: { color: colors.textMuted, fontSize: 12 },
})
