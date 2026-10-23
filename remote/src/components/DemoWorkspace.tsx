import { useState } from "react"
import { Platform, StyleSheet, View } from "react-native"
import { colors, type DetectedProcess, type RemoteJob } from "@clawtab/shared"
import { useResponsive } from "../hooks/useResponsive"
import { DemoOverview } from "./DemoOverview"
import { DemoAgentPane, type DemoSelection } from "./DemoAgentPane"
import { DemoJobList } from "./DemoJobList"

export let DemoWorkspace = ({ onConnect }: { onConnect: () => void }) => {
  let { isSplitView } = useResponsive()
  let [selection, setSelection] = useState<DemoSelection | null>(null)
  let selectJob = (job: RemoteJob) => setSelection({ id: job.slug, kind: "job" })
  let selectProcess = (process: DetectedProcess) => setSelection({ id: process.pane_id, kind: "process" })
  if (Platform.OS !== "web" || !isSplitView) return <DemoJobList onConnect={onConnect} />
  return <View style={styles.workspace}>
    <View style={styles.sidebar}><DemoJobList onConnect={onConnect} onShowOverview={() => setSelection(null)} selectedSlug={selection?.id} onSelectJob={selectJob} onSelectProcess={selectProcess} /></View>
    {selection ? <DemoAgentPane key={`${selection.kind}:${selection.id}`} {...selection} onShowOverview={() => setSelection(null)} /> : <DemoOverview onConnect={onConnect} />}
  </View>
}

let styles = StyleSheet.create({
  workspace: { flex: 1, minHeight: 0, flexDirection: "row", backgroundColor: colors.bg },
  sidebar: { width: 380, maxWidth: "45%", minHeight: 0, borderRightWidth: 1, borderRightColor: colors.border },
})
