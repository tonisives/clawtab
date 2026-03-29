import { useCallback, useEffect, useRef, useState } from "react"
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from "react-native"
import { useRouter } from "expo-router"
import { useJobsStore } from "../../src/store/jobs"
import { useWsStore } from "../../src/store/ws"
import { NotificationStack } from "../../src/components/NotificationStack"
import { DemoNotificationStack } from "../../src/components/DemoNotificationStack"
import { JobDetailPane } from "../../src/components/JobDetailPane"
import { ProcessDetailPane } from "../../src/components/ProcessDetailPane"
import { JobListView } from "@clawtab/shared"
import { getWsSend, nextId } from "../../src/hooks/useWebSocket"
import { _getLogListeners } from "../../src/transport/wsTransport"
import { registerRequest } from "../../src/lib/useRequestMap"
import { useResponsive } from "../../src/hooks/useResponsive"
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
  const [selectedJob, setSelectedJob] = useState<string | null>(null)
  const [selectedProcess, setSelectedProcess] = useState<string | null>(null)
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
          if (isWide) {
            setSelectedJob(ack.job_name)
          } else {
            router.push(`/job/${ack.job_name}`)
          }
        }
      })
    }
  }, [router, isWide])

  const handleSelectJob = useCallback((job: RemoteJob) => {
    if (isWide) {
      setSelectedJob(job.name)
      setSelectedProcess(null)
    } else {
      router.push(`/job/${job.name}${isDemo ? "?demo=1" : ""}`)
    }
  }, [router, isDemo, isWide])

  const handleSelectProcess = useCallback((process: ClaudeProcess) => {
    if (isWide) {
      setSelectedProcess(process.pane_id)
      setSelectedJob(null)
    } else {
      router.push(`/process/${process.pane_id.replace(/%/g, "_pct_")}`)
    }
  }, [router, isWide])

  const handleSendProcessInput = useCallback((paneId: string, text: string) => {
    const send = getWsSend()
    if (!send) return
    send({ type: "send_detected_process_input", id: nextId(), pane_id: paneId, text })
  }, [])

  const handleSendJobInput = useCallback((name: string, text: string) => {
    const send = getWsSend()
    if (!send) return
    send({ type: "send_input", id: nextId(), name, text })
  }, [])

  const handleSubscribeJobLogs = useCallback((name: string, onChunk: (content: string) => void) => {
    const send = getWsSend()
    if (send) send({ type: "subscribe_logs", id: nextId(), name })

    const listeners = _getLogListeners(name)
    listeners.add(onChunk)

    return () => {
      listeners.delete(onChunk)
      if (listeners.size === 0) {
        const s = getWsSend()
        if (s) s({ type: "unsubscribe_logs", name })
      }
    }
  }, [])

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

  const jobList = (
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
        onSendProcessInput={handleSendProcessInput}
        onSendJobInput={handleSendJobInput}
        onSubscribeJobLogs={handleSubscribeJobLogs}
        onRunAgent={desktopOnline ? handleRunAgent : undefined}
        headerContent={bannerContent}
        showEmpty={loaded || isDemo}
        emptyMessage={connected ? "No jobs found. Create jobs on your desktop." : "Connecting..."}
      />
    </View>
  )

  // Resizable list pane (web only)
  const [listWidth, setListWidth] = useState(() => {
    if (Platform.OS === "web" && typeof localStorage !== "undefined") {
      const v = localStorage.getItem("list_pane_width")
      if (v) return Math.max(260, Math.min(600, parseInt(v, 10)))
    }
    return 380
  })
  const handleRef = useRef<View>(null)

  useEffect(() => {
    if (Platform.OS !== "web" || !handleRef.current || !isWide) return
    const el = handleRef.current as unknown as HTMLElement
    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      const startX = e.pageX
      const startW = listWidth
      const onMouseMove = (ev: MouseEvent) => {
        const w = Math.max(260, Math.min(600, startW + (ev.pageX - startX)))
        setListWidth(w)
        localStorage.setItem("list_pane_width", String(w))
      }
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove)
        document.removeEventListener("mouseup", onMouseUp)
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
      }
      document.addEventListener("mousemove", onMouseMove)
      document.addEventListener("mouseup", onMouseUp)
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
    }
    el.addEventListener("mousedown", onMouseDown)
    return () => el.removeEventListener("mousedown", onMouseDown)
  }, [isWide, listWidth])

  if (!isWide) {
    return <View style={styles.container}>{jobList}</View>
  }

  return (
    <View style={styles.splitContainer}>
      <View style={[styles.listPane, { width: listWidth }]}>
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
          onSendProcessInput={handleSendProcessInput}
          onSendJobInput={handleSendJobInput}
          onSubscribeJobLogs={handleSubscribeJobLogs}
          onRunAgent={desktopOnline ? handleRunAgent : undefined}
          headerContent={bannerContent}
          showEmpty={loaded || isDemo}
          emptyMessage={connected ? "No jobs found. Create jobs on your desktop." : "Connecting..."}
        />
      </View>
      <View ref={handleRef} style={styles.resizeHandle} />
      <View style={styles.detailPane}>
        {selectedJob ? (
          <JobDetailPane
            key={selectedJob}
            jobName={selectedJob}
            isDemo={isDemo}
            onClose={() => setSelectedJob(null)}
          />
        ) : selectedProcess ? (
          <ProcessDetailPane
            key={selectedProcess}
            paneId={selectedProcess}
            onClose={() => setSelectedProcess(null)}
          />
        ) : (
          <View style={styles.emptyDetail}>
            <Text style={styles.emptyDetailText}>Select a job to view details</Text>
          </View>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  splitContainer: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: colors.bg,
  },
  listPane: {
    borderRightWidth: 1,
    borderRightColor: colors.border,
    backgroundColor: colors.bg,
  },
  resizeHandle: {
    width: 5,
    backgroundColor: "transparent",
    marginLeft: -3,
    marginRight: -2,
    zIndex: 10,
    ...(Platform.OS === "web" ? { cursor: "col-resize" as any } : {}),
  },
  detailPane: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  emptyDetail: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyDetailText: {
    color: colors.textMuted,
    fontSize: 15,
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
