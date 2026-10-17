import { useState } from "react"
import { Platform, StyleSheet, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { JobListView, colors, type JobListMode, type JobSortMode, type RemoteJob, type DetectedProcess } from "@clawtab/shared"
import { InsetList, InsetListRow } from "../../../shared/src/components/InsetList"
import { DEMO_JOBS, DEMO_PROCESSES, DEMO_STATUSES } from "../../src/demo/data"

let savedGroups: [] = []
let unavailable = () => {}
let DemoScreen = () => {
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
  let openJob = (job: RemoteJob) => router.push({ pathname: "/demo/[id]", params: { id: job.slug, kind: "job" } })
  let openProcess = (process: DetectedProcess) => router.push({ pathname: "/demo/[id]", params: { id: process.pane_id, kind: "process" } })
  let notice = <View style={styles.notice}>
    <Text style={styles.title}>Demo mode</Text>
    <Text style={styles.description}>Sample jobs and agents. Browse details and output without connecting a machine. Changes and agent actions are unavailable in this preview.</Text>
    <InsetList>
      <InsetListRow title="Add group / machine" onPress={unavailable} disabled />
      <InsetListRow title="Run agent actions" onPress={unavailable} disabled />
    </InsetList>
  </View>
  return <JobListView jobs={DEMO_JOBS} statuses={DEMO_STATUSES} detectedProcesses={DEMO_PROCESSES} savedGroups={savedGroups} compactMobileToolbar={Platform.OS !== "web"} groupTabView={groupTabView} onGroupTabViewChange={changeGroupView} onSetAllGroupTabView={changeAllGroupViews} collapsedGroups={collapsedGroups} onToggleGroup={toggleGroup} listMode={listMode} onListModeChange={setListMode} sortMode={sortMode} onSortChange={setSortMode} onSelectJob={openJob} onSelectProcess={openProcess} headerContent={notice} showEmpty />
}
export default DemoScreen

let styles = StyleSheet.create({
  notice: { padding: 24, gap: 16 },
  title: { color: colors.text, fontSize: 20, fontWeight: "600" },
  description: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
})
