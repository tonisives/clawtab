import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from "react-native"
import { useRouter } from "expo-router"
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent, type DragMoveEvent } from "@dnd-kit/core"
import { useJobsStore } from "../../src/store/jobs"
import { useWsStore } from "../../src/store/ws"
import { NotificationStack } from "../../src/components/NotificationStack"
import { DemoNotificationStack } from "../../src/components/DemoNotificationStack"
import { JobDetailPane } from "../../src/components/JobDetailPane"
import { ProcessDetailPane } from "../../src/components/ProcessDetailPane"
import { JobListView, SplitDetailArea, DropZoneOverlay, computeDropZone, JobCard, RunningJobCard, ProcessCard } from "@clawtab/shared"
import type { SplitDirection, DropZoneId } from "@clawtab/shared"
import { DraggableJobCard, DraggableProcessCard, type DragData } from "../../src/components/DraggableCards"
import { getWsSend, nextId } from "../../src/hooks/useWebSocket"
import { registerRequest } from "../../src/lib/useRequestMap"
import { useResponsive } from "../../src/hooks/useResponsive"
import { DemoBanner } from "../../src/components/DemoOverlay"
import { openUrl } from "../../src/lib/platform"
import { DEMO_JOBS, DEMO_STATUSES } from "../../src/demo/data"
import { colors } from "@clawtab/shared"
import { spacing } from "@clawtab/shared"
import type { RemoteJob, JobSortMode, JobStatus } from "@clawtab/shared"
import type { ClaudeProcess } from "@clawtab/shared"

// Capture URL params before expo-router rewrites them on init
const _initParams = Platform.OS === "web"
  ? new URLSearchParams(window.location.search)
  : null

/** Read initial selection: URL param (works for pasted URLs) or sessionStorage (survives refresh) */
function readSelection(key: "job" | "process"): string | null {
  if (Platform.OS !== "web") return null
  return _initParams?.get(key) ?? sessionStorage.getItem(`sel_${key}`)
}

/** Persist selection to sessionStorage and sync URL ?params */
function setSelection(key: "job" | "process", value: string | null) {
  if (Platform.OS !== "web") return
  const other = key === "job" ? "process" : "job"
  if (value) sessionStorage.setItem(`sel_${key}`, value)
  else sessionStorage.removeItem(`sel_${key}`)
  sessionStorage.removeItem(`sel_${other}`)
  syncUrlParams()
}

function syncUrlParams() {
  const job = sessionStorage.getItem("sel_job")
  const process = sessionStorage.getItem("sel_process")
  const url = new URL(window.location.href)
  if (job) url.searchParams.set("job", job)
  else url.searchParams.delete("job")
  if (process) url.searchParams.set("process", process)
  else url.searchParams.delete("process")
  window.history.replaceState(window.history.state, "", url.toString())
}

export default function JobsScreen() {
  const realJobs = useJobsStore((s) => s.jobs)
  const realStatuses = useJobsStore((s) => s.statuses)
  const detectedProcesses = useJobsStore((s) => s.detectedProcesses)
  const loaded = useJobsStore((s) => s.loaded)
  const connected = useWsStore((s) => s.connected)
  const desktopOnline = useWsStore((s) => s.desktopOnline)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [sortMode, setSortMode] = useState<JobSortMode>("name")
  const [selectedJob, setSelectedJob] = useState<string | null>(() => readSelection("job"))
  const [selectedProcess, setSelectedProcess] = useState<string | null>(() => readSelection("process"))
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
      setSelectedJob(job.slug)
      setSelectedProcess(null)
      setSelection("job", job.slug)
    } else {
      router.push(`/job/${job.name}${isDemo ? "?demo=1" : ""}`)
    }
  }, [router, isDemo, isWide])

  const handleSelectProcess = useCallback((process: ClaudeProcess) => {
    if (isWide) {
      setSelectedProcess(process.pane_id)
      setSelectedJob(null)
      setSelection("process", process.pane_id)
    } else {
      router.push(`/process/${process.pane_id.replace(/%/g, "_pct_")}`)
    }
  }, [router, isWide])

  // Restore URL ?params after expo-router finishes its initial URL rewrite
  useEffect(() => {
    if (Platform.OS !== "web") return
    if (!selectedJob && !selectedProcess) return
    // Delay to run after expo-router's init replaceState
    const t = setTimeout(syncUrlParams, 0)
    return () => clearTimeout(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Split pane state (web wide mode only)
  type SplitItem = { kind: "job"; slug: string } | { kind: "process"; paneId: string }
  const [splitItem, setSplitItem] = useState<SplitItem | null>(null)
  const [splitDirection, setSplitDirection] = useState<SplitDirection>(() => {
    if (Platform.OS !== "web") return "horizontal"
    return (localStorage.getItem("remote_split_direction") as SplitDirection) || "horizontal"
  })
  const [splitRatio, setSplitRatio] = useState(() => {
    if (Platform.OS !== "web") return 0.5
    const v = localStorage.getItem("remote_split_ratio")
    return v ? Math.max(0.2, Math.min(0.8, parseFloat(v))) : 0.5
  })

  // DnD state
  const [isDragging, setIsDragging] = useState(false)
  const [dragActiveZone, setDragActiveZone] = useState<DropZoneId | null>(null)
  const [dragOverlayData, setDragOverlayData] = useState<DragData | null>(null)
  const detailPaneRef = useRef<View>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setIsDragging(true)
    setDragOverlayData(event.active.data.current as DragData)
  }, [])

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const el = detailPaneRef.current as unknown as HTMLElement
    if (!el) { setDragActiveZone(null); return }
    const rect = el.getBoundingClientRect()
    const act = event.activatorEvent as PointerEvent
    const px = act.clientX + event.delta.x
    const py = act.clientY + event.delta.y

    if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) {
      setDragActiveZone(null)
      return
    }

    const zone = computeDropZone(
      px - rect.left, py - rect.top, rect.width, rect.height,
      splitItem !== null, splitDirection, splitRatio,
    )
    setDragActiveZone(zone)
  }, [splitItem, splitDirection, splitRatio])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setIsDragging(false)
    setDragOverlayData(null)
    const zone = dragActiveZone
    setDragActiveZone(null)

    if (!zone) return
    const data = event.active.data.current as DragData
    if (!data) return

    const item: SplitItem = data.kind === "job"
      ? { kind: "job", slug: data.slug }
      : { kind: "process", paneId: data.paneId }

    if (zone === "replace-current") {
      if (data.kind === "job") handleSelectJob(data.job)
      else handleSelectProcess(data.process)
      return
    }

    if (zone === "replace-primary") {
      if (data.kind === "job") handleSelectJob(data.job)
      else handleSelectProcess(data.process)
      return
    }

    if (zone === "replace-secondary") {
      setSplitItem(item)
      return
    }

    // Split zones
    const dir: SplitDirection =
      zone === "split-horizontal-left" || zone === "split-horizontal-right"
        ? "horizontal"
        : "vertical"

    setSplitDirection(dir)
    localStorage.setItem("remote_split_direction", dir)
    setSplitRatio(0.5)
    localStorage.setItem("remote_split_ratio", "0.5")

    if (zone === "split-horizontal-left" || zone === "split-vertical-top") {
      const currentPrimary: SplitItem | null = selectedProcess
        ? { kind: "process", paneId: selectedProcess }
        : selectedJob
          ? { kind: "job", slug: selectedJob }
          : null
      setSplitItem(currentPrimary)
      if (data.kind === "job") handleSelectJob(data.job)
      else handleSelectProcess(data.process)
    } else {
      setSplitItem(item)
    }
  }, [dragActiveZone, selectedJob, selectedProcess, handleSelectJob, handleSelectProcess])

  const handleDragCancel = useCallback(() => {
    setIsDragging(false)
    setDragOverlayData(null)
    setDragActiveZone(null)
  }, [])

  const handleSplitRatioChange = useCallback((ratio: number) => {
    setSplitRatio(ratio)
    if (Platform.OS === "web") localStorage.setItem("remote_split_ratio", String(ratio))
  }, [])

  const handleClosePrimary = useCallback(() => {
    if (splitItem) {
      if (splitItem.kind === "job") {
        setSelectedJob(splitItem.slug)
        setSelectedProcess(null)
        setSelection("job", splitItem.slug)
      } else {
        setSelectedProcess(splitItem.paneId)
        setSelectedJob(null)
        setSelection("process", splitItem.paneId)
      }
    }
    setSplitItem(null)
  }, [splitItem])

  const handleCloseSecondary = useCallback(() => {
    setSplitItem(null)
  }, [])

  const renderDraggableJobCard = useCallback(
    (props: { job: RemoteJob; status: JobStatus; onPress?: () => void; selected?: boolean }) => (
      <DraggableJobCard {...props} />
    ),
    [],
  )

  const renderDraggableProcessCard = useCallback(
    (props: { process: ClaudeProcess; onPress?: () => void; inGroup?: boolean; selected?: boolean }) => (
      <DraggableProcessCard {...props} />
    ),
    [],
  )

  const processesLoaded = useJobsStore((s) => s.processesLoaded)

  // Clear selection when a detected process disappears (e.g. killed)
  // Only after processes have been loaded at least once, to avoid clearing
  // URL-restored selections before WS delivers the process list.
  useEffect(() => {
    if (!processesLoaded) return
    if (selectedProcess && !detectedProcesses.find((p) => p.pane_id === selectedProcess)) {
      setSelectedProcess(null)
      setSelection("process", null)
    }
  }, [detectedProcesses, selectedProcess, processesLoaded])

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

  // Primary pane content
  const primaryContent = selectedJob ? (
    <JobDetailPane
      key={selectedJob}
      jobName={selectedJob}
      isDemo={isDemo}
      onClose={() => {
        setSelectedJob(null)
        setSelection("job", null)
      }}
    />
  ) : selectedProcess ? (
    <ProcessDetailPane
      key={selectedProcess}
      paneId={selectedProcess}
      onClose={() => {
        setSelectedProcess(null)
        setSelection("process", null)
      }}
    />
  ) : (
    <View style={styles.emptyDetail}>
      <Text style={styles.emptyDetailText}>Select a job to view details</Text>
    </View>
  )

  // Secondary pane content
  const secondaryContent = splitItem ? (
    splitItem.kind === "job" ? (
      <JobDetailPane
        key={`split-${splitItem.slug}`}
        jobName={splitItem.slug}
        isDemo={isDemo}
        onClose={() => setSplitItem(null)}
      />
    ) : (
      <ProcessDetailPane
        key={`split-${splitItem.paneId}`}
        paneId={splitItem.paneId}
        onClose={() => setSplitItem(null)}
      />
    )
  ) : null

  // Drag overlay
  const dragOverlayContent = dragOverlayData ? (
    <div style={{ opacity: 0.8, pointerEvents: "none" as const, width: 300 }}>
      {dragOverlayData.kind === "job" ? (
        (() => {
          const s = statuses[dragOverlayData.slug] ?? { state: "idle" as const }
          return s.state === "running"
            ? <RunningJobCard jobName={dragOverlayData.job.name} status={s} />
            : <JobCard job={dragOverlayData.job} status={s} />
        })()
      ) : (
        <ProcessCard process={dragOverlayData.process} />
      )}
    </div>
  ) : null

  // Drop zone overlay
  const dropOverlay = isDragging ? (
    <DropZoneOverlay
      isSplit={splitItem !== null}
      splitDirection={splitDirection}
      splitRatio={splitRatio}
      activeZone={dragActiveZone}
    />
  ) : null

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
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
            selectedSlug={selectedJob ?? selectedProcess ?? null}
            onRunAgent={desktopOnline ? handleRunAgent : undefined}
            headerContent={bannerContent}
            showEmpty={loaded || isDemo}
            emptyMessage={connected ? "No jobs found. Create jobs on your desktop." : "Connecting..."}
            scrollEnabled={!isDragging}
            renderJobCard={renderDraggableJobCard}
            renderProcessCard={renderDraggableProcessCard}
          />
        </View>
        <View ref={handleRef} style={styles.resizeHandle} />
        <View ref={detailPaneRef} style={styles.detailPane}>
          <SplitDetailArea
            primaryContent={primaryContent}
            secondaryContent={secondaryContent}
            direction={splitDirection}
            ratio={splitRatio}
            onRatioChange={handleSplitRatioChange}
            onClosePrimary={splitItem ? handleClosePrimary : undefined}
            onCloseSecondary={splitItem ? handleCloseSecondary : undefined}
            overlay={dropOverlay}
          />
        </View>
      </View>
      <DragOverlay dropAnimation={null}>
        {dragOverlayContent}
      </DragOverlay>
    </DndContext>
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
