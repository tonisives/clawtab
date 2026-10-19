import { Pressable, StyleSheet, Text, View } from "react-native"
import { colors } from "@clawtab/shared"
import { InsetList, InsetListRow } from "../../../shared/src/components/InsetList"
import { SettingsPage } from "./settings/SettingsPage"
import { DEMO_JOBS, DEMO_LOGS, DEMO_PROCESSES, DEMO_RUNS, DEMO_STATUSES } from "../demo/data"
import { showDemoInfo } from "../demo/info"

let unavailable = () => {}
export let DemoDetailsContent = ({ id, kind }: { id: string; kind?: string }) => {
  let job = kind === "job" ? DEMO_JOBS.find((item) => item.slug === id) : undefined
  let process = kind === "process" ? DEMO_PROCESSES.find((item) => item.pane_id === id) : undefined
  let title = job?.display_name ?? job?.name ?? process?.display_name ?? "Sample agent"
  let output = job ? DEMO_LOGS[job.slug] : process?.log_lines
  if (!job && !process) return <SettingsPage><Text style={styles.description}>This sample was not found. Go back to the demo list.</Text></SettingsPage>
  return <SettingsPage>
    <Pressable accessibilityRole="button" accessibilityLabel="About demo mode" onPress={showDemoInfo} style={styles.demoButton}>
      <Text style={[styles.description, styles.demoNotice]}>Demo mode · Sample data</Text>
    </Pressable>
    <InsetList>
      <InsetListRow title={title} description={job ? DEMO_STATUSES[job.slug]?.state : process?.provider} />
      <InsetListRow title="Folder" description={job?.work_dir ?? process?.cwd} selectable />
      {job && <InsetListRow title="Schedule" description={job.cron || "Manual"} />}
      <InsetListRow title="Agent actions" description="Connect a machine to run actions." onPress={unavailable} disabled />
    </InsetList>
    {process?.first_query && <InsetList><InsetListRow title="First command" description={process.first_query} selectable /><InsetListRow title="Latest command" description={process.last_query} selectable /></InsetList>}
    {!!output && <View style={styles.section}>
      <Text style={styles.heading}>Output</Text>
      <View style={styles.output}><Text selectable style={styles.log}>{output}</Text></View>
    </View>}
    {job && !!DEMO_RUNS[job.slug]?.length && <View style={styles.section}>
      <Text style={styles.heading}>Runs</Text>
      <InsetList>{DEMO_RUNS[job.slug].map((run) => <InsetListRow key={run.id} title={run.finished_at ? run.exit_code === 0 ? "Completed" : "Failed" : "Running"} description={new Date(run.started_at).toLocaleString()} />)}</InsetList>
    </View>}
  </SettingsPage>
}
let styles = StyleSheet.create({
  section: { gap: 12 },
  heading: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },
  description: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  demoNotice: { color: colors.warning },
  demoButton: { minHeight: 44, justifyContent: "center" },
  output: { padding: 18, backgroundColor: colors.surface, borderRadius: 24, borderCurve: "continuous" },
  log: { color: colors.text, fontSize: 12, lineHeight: 18, fontFamily: "monospace" },
})
