import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { JobListView, colors, type JobListMode, type JobSortMode, type RemoteJob, type DetectedProcess } from "@clawtab/shared"
import { DEMO_JOBS, DEMO_PROCESSES, DEMO_STATUSES } from "../demo/data"

let savedGroups: [] = []
export let DemoJobList = ({ onConnect }: { onConnect: () => void }) => {
  let router = useRouter()
  let [collapsedGroups, setCollapsedGroups] = useState(new Set<string>())
  let [listMode, setListMode] = useState<JobListMode>("tabs")
  let [groupTabView, setGroupTabView] = useState<Record<string, "tabs" | "jobs">>({})
  let changeGroupView = (group: string, view: "tabs" | "jobs") => setGroupTabView((current) => ({ ...current, [group]: view }))
  let changeAllGroupViews = (groups: string[], view: "tabs" | "jobs") => setGroupTabView((current) => ({ ...current, ...Object.fromEntries(groups.map((group) => [group, view])) }))
  let [sortMode, setSortMode] = useState<JobSortMode>("name")
  let toggleGroup = (group: string) => setCollapsedGroups((current) => {
    let next = new Set(current)
    if (next.has(group)) next.delete(group)
    else next.add(group)
    return next
  })
  let openJob = (job: RemoteJob) => router.push({ pathname: "/demo-agent", params: { id: job.slug, kind: "job" } })
  let openProcess = (process: DetectedProcess) => router.push({ pathname: "/demo-agent", params: { id: process.pane_id, kind: "process" } })
  let notice = <View style={styles.notice} accessibilityRole="alert">
    <Ionicons name="alert-circle-outline" size={20} color={colors.warning} />
    <Text style={styles.title}>Demo</Text>
    <Text style={styles.separator}>·</Text>
    <Pressable accessibilityRole="button" onPress={onConnect} style={styles.connectButton}><Text style={styles.connect}>Connect to relay</Text></Pressable>
  </View>
  return <JobListView jobs={DEMO_JOBS} statuses={DEMO_STATUSES} detectedProcesses={DEMO_PROCESSES} savedGroups={savedGroups} compactMobileToolbar mobileAppearance groupTabView={groupTabView} onGroupTabViewChange={changeGroupView} onSetAllGroupTabView={changeAllGroupViews} collapsedGroups={collapsedGroups} onToggleGroup={toggleGroup} listMode={listMode} onListModeChange={setListMode} sortMode={sortMode} onSortChange={setSortMode} onSelectJob={openJob} onSelectProcess={openProcess} headerContent={notice} contentContainerStyle={styles.content} showEmpty />
}

let styles = StyleSheet.create({
  content: { width: "100%", padding: 0 },
  notice: { paddingHorizontal: 24, paddingVertical: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: 8 },
  title: { color: colors.warning, fontSize: 16, fontWeight: "600" },
  separator: { color: colors.warning, fontSize: 14 },
  connectButton: { minHeight: 44, paddingHorizontal: 16, justifyContent: "center", borderRadius: 22, backgroundColor: colors.surface },
  connect: { color: colors.accent, fontSize: 16, fontWeight: "600" },
})
