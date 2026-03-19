import { useCallback, useState } from "react"
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native"
import { useRouter } from "expo-router"
import { useJobsStore } from "../../src/store/jobs"
import { useWsStore } from "../../src/store/ws"
import { NotificationStack } from "../../src/components/NotificationStack"
import { DemoNotificationStack } from "../../src/components/DemoNotificationStack"
import { JobListView } from "@clawtab/shared"
import { getWsSend, nextId } from "../../src/hooks/useWebSocket"
import { registerRequest } from "../../src/lib/useRequestMap"
import { useResponsive, WIDE_CONTENT_MAX_WIDTH } from "../../src/hooks/useResponsive"
import { DemoBanner } from "../../src/components/DemoOverlay"
import { openUrl } from "../../src/lib/platform"
import { DEMO_JOBS, DEMO_STATUSES } from "../../src/demo/data"
import { colors } from "@clawtab/shared"
import { spacing } from "@clawtab/shared"
import type { RemoteJob, JobSortMode } from "@clawtab/shared"
import type { ClaudeProcess } from "@clawtab/shared"

export default function JobsScreen() {
  const realJobs = useJobsStore((s) => s.jobs)
  const realStatuses = useJobsStore((s) => s.statuses)
  const detectedProcesses = useJobsStore((s) => s.detectedProcesses)
  const loaded = useJobsStore((s) => s.loaded)
  const connected = useWsStore((s) => s.connected)
  const desktopOnline = useWsStore((s) => s.desktopOnline)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [sortMode, setSortMode] = useState<JobSortMode>("name")
  const { isWide } = useResponsive()
  const router = useRouter()

  const isDemo = connected && !desktopOnline && realJobs.length === 0
  const jobs = isDemo ? DEMO_JOBS : realJobs
  const statuses = isDemo ? DEMO_STATUSES : realStatuses


  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }, [])

  const handleRefresh = useCallback(() => {
    const send = getWsSend()
    if (send) {
      send({ type: "list_jobs", id: nextId() })
    }
  }, [])

  const handleRunAgent = useCallback((prompt: string, workDir?: string) => {
    const send = getWsSend()
    if (!send) return
    const id = nextId()
    send({ type: "run_agent", id, prompt, work_dir: workDir })
    if (workDir) {
      registerRequest<{ job_name?: string }>(id).then((ack) => {
        if (ack.job_name) {
          router.push(`/job/${ack.job_name}`)
        }
      })
    }
  }, [router])

  const handleSelectJob = useCallback((job: RemoteJob) => {
    router.push(`/job/${job.name}${isDemo ? "?demo=1" : ""}`)
  }, [router, isDemo])

  const handleSelectProcess = useCallback((process: ClaudeProcess) => {
    router.push(`/process/${process.pane_id.replace(/%/g, "_pct_")}`)
  }, [router])

  const bannerContent = (
    <>
      {!connected && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Connecting to relay...</Text>
        </View>
      )}
      {connected && !desktopOnline && !isDemo && realJobs.length > 0 && (
        <View style={[styles.banner, styles.bannerWarn]}>
          <Text style={styles.bannerText}>Desktop not connected</Text>
        </View>
      )}
      {connected && !loaded && !isDemo && (
        desktopOnline ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.loadingText}>Loading jobs...</Text>
          </View>
        ) : (
          <View style={styles.loadingContainer}>
            <Text style={styles.offlineTitle}>Desktop not connected</Text>
            <Text style={styles.offlineText}>Please install ClawTab desktop and sign in to same account.</Text>
            <TouchableOpacity onPress={() => openUrl("https://clawtab.cc/docs#quick-start")} activeOpacity={0.7}>
              <Text style={styles.linkText}>Quick Start Guide</Text>
            </TouchableOpacity>
          </View>
        )
      )}
      {isDemo ? <DemoNotificationStack /> : <NotificationStack />}
    </>
  )

  return (
    <View style={styles.container}>
      {isDemo && <DemoBanner />}
      <JobListView
            jobs={jobs}
            statuses={statuses}
            detectedProcesses={detectedProcesses}
            collapsedGroups={collapsedGroups}
            onToggleGroup={toggleGroup}
            onRefresh={handleRefresh}
            sortMode={sortMode}
            onSortChange={setSortMode}
            onSelectJob={handleSelectJob}
            onSelectProcess={handleSelectProcess}
            onRunAgent={desktopOnline ? handleRunAgent : undefined}
            headerContent={bannerContent}
            showEmpty={loaded || isDemo}
            emptyMessage={connected ? "No jobs found. Create jobs on your desktop." : "Connecting..."}
            contentContainerStyle={isWide ? styles.wideContent : undefined}
          />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  wideContent: {
    maxWidth: WIDE_CONTENT_MAX_WIDTH,
    width: "100%",
    alignSelf: "center" as const,
  },
  loadingContainer: {
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: 60,
  },
  loadingText: { color: colors.textMuted, fontSize: 13 },
  offlineTitle: { color: colors.warning, fontSize: 15, fontWeight: "600" as const },
  offlineText: { color: colors.textMuted, fontSize: 13, textAlign: "center" as const },
  linkText: { color: colors.accent, fontSize: 14, fontWeight: "500" as const },
  banner: {
    backgroundColor: colors.surface,
    padding: spacing.sm,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bannerWarn: { backgroundColor: "#332800" },
  bannerText: { color: colors.textSecondary, fontSize: 12 },
})
