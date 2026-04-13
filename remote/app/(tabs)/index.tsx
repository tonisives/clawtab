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
import { DndContext, DragOverlay } from "@dnd-kit/core"
import { useJobsStore } from "../../src/store/jobs"
import { useWsStore } from "../../src/store/ws"
import { JobDetailPane } from "../../src/components/JobDetailPane"
import { ProcessDetailPane } from "../../src/components/ProcessDetailPane"
import {
  JobListView, SplitDetailArea, DropZoneOverlay,
  JobCard, RunningJobCard, ProcessCard,
  useSplitTree,
} from "@clawtab/shared"
import type { PaneContent, SplitDragData } from "@clawtab/shared"
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
import type { DetectedProcess, ProcessProvider } from "@clawtab/shared"

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

  const handleRunAgent = useCallback((prompt: string, workDir?: string, provider?: ProcessProvider, model?: string | null) => {
    const send = getWsSend()
    if (!send) return
    const id = nextId()
    send({
      type: "run_agent",
      id,
      prompt,
      work_dir: workDir,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    })
    if (workDir) {
      registerRequest<{ job_id?: string }>(id).then((ack) => {
        if (ack.job_id) {
          if (isWide) {
            setSelectedJob(ack.job_id)
          } else {
            router.push(`/job/${ack.job_id}`)
          }
        }
      })
    }
    // Trigger a fresh process detection so the new agent appears quickly
    setTimeout(() => {
      const s = getWsSend()
      if (s) s({ type: "detect_processes", id: nextId() })
    }, 1500)
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

  const handleSelectProcess = useCallback((process: DetectedProcess) => {
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

  // Compute current single-pane content for the split tree hook
  const currentContent: PaneContent | null = useMemo(() => {
    if (selectedJob) return { kind: "job", slug: selectedJob }
    if (selectedProcess) return { kind: "process", paneId: selectedProcess }
    return null
  }, [selectedJob, selectedProcess])

  const split = useSplitTree({
    storageKey: "remote_split_tree",
    minPaneSize: 200,
    onCollapse: useCallback((content: PaneContent) => {
      if (content.kind === "job") {
        setSelectedJob(content.slug)
        setSelectedProcess(null)
        setSelection("job", content.slug)
      } else if (content.kind === "process") {
        setSelectedProcess(content.paneId)
        setSelectedJob(null)
        setSelection("process", content.paneId)
      }
    }, []),
    onReplaceSingle: useCallback((data: SplitDragData) => {
      if (data.kind === "job") {
        const job = jobs.find(j => j.slug === data.slug)
        if (job) handleSelectJob(job)
      } else if (data.kind === "process") {
        const proc = detectedProcesses.find(p => p.pane_id === data.paneId)
        if (proc) handleSelectProcess(proc)
      }
    }, [jobs, detectedProcesses, handleSelectJob, handleSelectProcess]),
    currentContent,
  })

  // Wrap select handlers to check tree first
  const handleSelectJobWithTree = useCallback((job: RemoteJob) => {
    if (!isWide) {
      router.push(`/job/${job.name}${isDemo ? "?demo=1" : ""}`)
      return
    }
    const content: PaneContent = { kind: "job", slug: job.slug }
    if (split.tree && split.handleSelectInTree(content)) return
    handleSelectJob(job)
  }, [isWide, isDemo, router, split.tree, split.handleSelectInTree, handleSelectJob])

  const handleSelectProcessWithTree = useCallback((process: DetectedProcess) => {
    if (!isWide) {
      router.push(`/process/${process.pane_id.replace(/%/g, "_pct_")}`)
      return
    }
    const content: PaneContent = { kind: "process", paneId: process.pane_id }
    if (split.tree && split.handleSelectInTree(content)) return
    handleSelectProcess(process)
  }, [isWide, router, split.tree, split.handleSelectInTree, handleSelectProcess])

  const renderDraggableJobCard = useCallback(
    (props: { job: RemoteJob; status: JobStatus; onPress?: () => void; selected?: boolean | string }) => (
      <DraggableJobCard {...props} />
    ),
    [],
  )

  const renderDraggableProcessCard = useCallback(
    (props: { process: DetectedProcess; onPress?: () => void; inGroup?: boolean; selected?: boolean | string }) => (
      <DraggableProcessCard {...props} />
    ),
    [],
  )

  const processesLoaded = useJobsStore((s) => s.processesLoaded)

  // Clear stale selections when processes disappear
  useEffect(() => {
    if (!processesLoaded) return
    if (selectedProcess && !detectedProcesses.find((p) => p.pane_id === selectedProcess)) {
      setSelectedProcess(null)
      setSelection("process", null)
    }
    split.cleanStaleLeaves((content) => {
      if (content.kind === "process") {
        return !detectedProcesses.find((p) => p.pane_id === content.paneId)
      }
      return false
    })
  }, [detectedProcesses, selectedProcess, processesLoaded, split.cleanStaleLeaves])

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

  // Render leaf content
  const renderLeaf = useCallback((content: PaneContent, leafId: string) => {
    if (content.kind === "job") {
      return (
        <JobDetailPane
          key={`leaf-${leafId}-${content.slug}`}
          jobName={content.slug}
          isDemo={isDemo}
          onClose={() => split.handleClosePane(leafId)}
        />
      )
    }
    if (content.kind === "process") {
      return (
        <ProcessDetailPane
          key={`leaf-${leafId}-${content.paneId}`}
          paneId={content.paneId}
          onClose={() => split.handleClosePane(leafId)}
        />
      )
    }
    return null
  }, [isDemo, split.handleClosePane])

  // Non-tree primary content (when no split tree)
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

  // Drag overlay
  const dragOverlayContent = (() => {
    const data = split.dragOverlayData as DragData | null
    if (!data) return null
    return (
      <div style={{ opacity: 0.8, pointerEvents: "none" as const, width: 300 }}>
        {data.kind === "job" ? (
          (() => {
            const s = statuses[data.slug] ?? { state: "idle" as const }
            return s.state === "running"
              ? <RunningJobCard job={data.job} status={s} />
              : <JobCard job={data.job} status={s} />
          })()
        ) : (
          <ProcessCard process={data.process} />
        )}
      </div>
    )
  })()

  const dropOverlay = split.isDragging ? (
    <DropZoneOverlay
      tree={split.effectiveTreeForOverlay}
      containerW={split.detailSize.w}
      containerH={split.detailSize.h}
      activeZone={split.dragActiveZone}
    />
  ) : null

  const emptyContent = (
    <View style={styles.emptyDetail}>
      <Text style={styles.emptyDetailText}>Select a job to view details</Text>
    </View>
  )

  return (
    <DndContext
      sensors={split.sensors}
      onDragStart={split.handleDragStart}
      onDragMove={split.handleDragMove}
      onDragEnd={split.handleDragEnd}
      onDragCancel={split.handleDragCancel}
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
            onSelectJob={handleSelectJobWithTree}
            onSelectProcess={handleSelectProcessWithTree}
            selectedItems={split.selectedItems}
            focusedItemKey={split.focusedItemKey}
            onRunAgent={desktopOnline ? handleRunAgent : undefined}
            headerContent={bannerContent}
            showEmpty={loaded || isDemo}
            emptyMessage={connected ? "No jobs found. Create jobs on your desktop." : "Connecting..."}
            scrollEnabled={!split.isDragging}
            renderJobCard={renderDraggableJobCard}
            renderProcessCard={renderDraggableProcessCard}
          />
        </View>
        <View ref={handleRef} style={styles.resizeHandle} />
        <View ref={split.detailPaneRef as unknown as React.Ref<View>} style={styles.detailPane}>
          <SplitDetailArea
            tree={split.tree}
            renderLeaf={renderLeaf}
            onRatioChange={split.handleSplitRatioChange}
            onFocusLeaf={split.setFocusedLeafId}
            focusedLeafId={split.focusedLeafId}
            paneColors={split.paneColors}
            emptyContent={primaryContent}
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
