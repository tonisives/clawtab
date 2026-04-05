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
import {
  JobListView, SplitDetailArea, DropZoneOverlay, computeDropZone,
  JobCard, RunningJobCard, ProcessCard,
  collectLeaves, replaceNode, removeLeaf, splitLeaf, updateRatio,
  genPaneId, restoreIdCounter, removeStaleLeaves, assignPaneColors,
} from "@clawtab/shared"
import type { SplitNode, PaneContent, DropZoneId } from "@clawtab/shared"
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

/** Load split tree from localStorage, migrating old flat state if needed */
function loadSplitTree(): SplitNode | null {
  if (Platform.OS !== "web") return null
  const saved = localStorage.getItem("remote_split_tree")
  if (saved) {
    try {
      const tree = JSON.parse(saved) as SplitNode
      restoreIdCounter(tree)
      return tree
    } catch { /* ignore corrupt data */ }
  }
  // Migrate old flat split state
  const oldDir = localStorage.getItem("remote_split_direction")
  if (oldDir) {
    localStorage.removeItem("remote_split_direction")
    localStorage.removeItem("remote_split_ratio")
  }
  return null
}

function saveSplitTree(tree: SplitNode | null) {
  if (Platform.OS !== "web") return
  if (tree) localStorage.setItem("remote_split_tree", JSON.stringify(tree))
  else localStorage.removeItem("remote_split_tree")
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

  // Split tree state
  const [splitTree, setSplitTree] = useState<SplitNode | null>(loadSplitTree)
  const [focusedLeafId, setFocusedLeafId] = useState<string | null>(null)

  // Persist tree on change
  useEffect(() => {
    console.log("[split] tree changed:", splitTree ? `${collectLeaves(splitTree).length} leaves` : "null")
    saveSplitTree(splitTree)
  }, [splitTree])

  // DnD state
  const [isDragging, setIsDragging] = useState(false)
  const [dragActiveZone, setDragActiveZone] = useState<DropZoneId | null>(null)
  const dragActiveZoneRef = useRef<DropZoneId | null>(null)
  const [dragOverlayData, setDragOverlayData] = useState<DragData | null>(null)
  const detailPaneRef = useRef<View>(null)
  const [detailSize, setDetailSize] = useState({ w: 0, h: 0 })

  // Refs for values read in drag handlers to avoid stale closures
  // (dnd-kit may hold handlers from drag start)
  const splitTreeRef = useRef(splitTree)
  splitTreeRef.current = splitTree
  const selectedJobRef = useRef(selectedJob)
  selectedJobRef.current = selectedJob
  const selectedProcessRef = useRef(selectedProcess)
  selectedProcessRef.current = selectedProcess

  // Track detail pane size for drop zone computation
  useEffect(() => {
    if (Platform.OS !== "web") return
    const el = detailPaneRef.current as unknown as HTMLElement
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setDetailSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [isWide])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setIsDragging(true)
    setDragOverlayData(event.active.data.current as DragData)
  }, [])

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const el = detailPaneRef.current as unknown as HTMLElement
    if (!el) { dragActiveZoneRef.current = null; setDragActiveZone(null); return }
    const rect = el.getBoundingClientRect()
    const act = event.activatorEvent as PointerEvent
    const px = act.clientX + event.delta.x
    const py = act.clientY + event.delta.y

    if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) {
      dragActiveZoneRef.current = null
      setDragActiveZone(null)
      return
    }

    // If no tree yet, create a synthetic single-leaf for initial drop zone computation
    const tree = splitTreeRef.current
    const job = selectedJobRef.current
    const process = selectedProcessRef.current
    const effectiveTree = tree ?? (job || process
      ? { type: "leaf" as const, id: "_root", content: job
          ? { kind: "job" as const, slug: job }
          : { kind: "process" as const, paneId: process! } }
      : null)

    const zone = computeDropZone(
      px - rect.left, py - rect.top, rect.width, rect.height,
      effectiveTree, 200,
    )
    // DEBUG - remove after testing
    console.log('[drag]', {
      hasTree: !!tree,
      treeType: tree?.type,
      containerW: rect.width,
      containerH: rect.height,
      relPx: px - rect.left,
      relPy: py - rect.top,
      zone: zone ? (zone.action === 'split' ? `split-${zone.direction}-${zone.position}` : zone.action) : null,
    })
    dragActiveZoneRef.current = zone
    setDragActiveZone(zone)
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setIsDragging(false)
    setDragOverlayData(null)
    const zone = dragActiveZoneRef.current
    dragActiveZoneRef.current = null
    setDragActiveZone(null)

    if (!zone) return
    const data = event.active.data.current as DragData
    if (!data) return

    const newContent: PaneContent = data.kind === "job"
      ? { kind: "job", slug: data.slug }
      : { kind: "process", paneId: data.paneId }

    const currentTree = splitTreeRef.current
    const currentSelectedJob = selectedJobRef.current
    const currentSelectedProcess = selectedProcessRef.current

    // If no tree exists yet, the primary selection was shown as a virtual root
    if (!currentTree) {
      const currentContent: PaneContent | null = currentSelectedJob
        ? { kind: "job", slug: currentSelectedJob }
        : currentSelectedProcess
          ? { kind: "process", paneId: currentSelectedProcess }
          : null

      if (zone.action === "replace") {
        // Replace the current view
        if (data.kind === "job") handleSelectJob(data.job)
        else handleSelectProcess(data.process)
        return
      }

      // Split: create tree with current + new (skip if same item)
      if (currentContent) {
        const sameItem =
          (currentContent.kind === "job" && newContent.kind === "job" && currentContent.slug === newContent.slug) ||
          (currentContent.kind === "process" && newContent.kind === "process" && currentContent.paneId === newContent.paneId)
        if (sameItem) return

        const rootLeaf: SplitNode = { type: "leaf", id: genPaneId(), content: currentContent }
        const newLeaf: SplitNode = { type: "leaf", id: genPaneId(), content: newContent }
        const tree: SplitNode = {
          type: "split",
          id: genPaneId(),
          direction: zone.direction,
          ratio: 0.5,
          first: zone.position === "before" ? newLeaf : rootLeaf,
          second: zone.position === "after" ? newLeaf : rootLeaf,
        }
        setSplitTree(tree)
        setFocusedLeafId(rootLeaf.id)
        // Clear single-item selection since tree now manages it
        setSelectedJob(null)
        setSelectedProcess(null)
      }
      return
    }

    // Tree exists - check if item is already in a pane (move instead of duplicate)
    setSplitTree(prev => {
      if (!prev) return prev
      // Find existing leaf with the same content
      const leaves = collectLeaves(prev)
      const existingLeaf = leaves.find(l => {
        if (newContent.kind === "job" && l.content.kind === "job") return l.content.slug === newContent.slug
        if (newContent.kind === "process" && l.content.kind === "process") return l.content.paneId === newContent.paneId
        return false
      })

      let tree = prev
      if (existingLeaf) {
        // Remove from old location first
        const removed = removeLeaf(tree, existingLeaf.id)
        if (!removed) return prev // was the only leaf, nothing to move
        tree = removed
        // If the target leaf was removed (same leaf), just focus it
        if (existingLeaf.id === zone.leafId) return prev
      }

      if (zone.action === "replace") {
        return replaceNode(tree, zone.leafId, { type: "leaf", id: zone.leafId, content: newContent })
      }
      return splitLeaf(tree, zone.leafId, newContent, zone.direction, zone.position)
    })
  }, [handleSelectJob, handleSelectProcess])

  const handleDragCancel = useCallback(() => {
    setIsDragging(false)
    setDragOverlayData(null)
    dragActiveZoneRef.current = null
    setDragActiveZone(null)
  }, [])

  const handleSplitRatioChange = useCallback((splitNodeId: string, ratio: number) => {
    setSplitTree(prev => prev ? updateRatio(prev, splitNodeId, ratio) : null)
  }, [])

  const handleClosePane = useCallback((leafId: string) => {
    setSplitTree(prev => {
      if (!prev) return null
      const result = removeLeaf(prev, leafId)
      // If only one leaf remains, extract it back to selectedJob/selectedProcess
      if (result && result.type === "leaf") {
        if (result.content.kind === "job") {
          setSelectedJob(result.content.slug)
          setSelectedProcess(null)
          setSelection("job", result.content.slug)
        } else {
          setSelectedProcess(result.content.paneId)
          setSelectedJob(null)
          setSelection("process", result.content.paneId)
        }
        return null
      }
      return result
    })
    if (focusedLeafId === leafId) setFocusedLeafId(null)
  }, [focusedLeafId])

  // When clicking a sidebar item with a tree active:
  // - If item is already in a pane, focus that pane
  // - Otherwise, replace the focused leaf's content
  const handleSelectJobWithTree = useCallback((job: RemoteJob) => {
    if (!isWide) {
      router.push(`/job/${job.name}${isDemo ? "?demo=1" : ""}`)
      return
    }
    if (splitTree) {
      // Check if this job is already in a pane - if so, just focus it
      const leaves = collectLeaves(splitTree)
      const existingLeaf = leaves.find(l => l.content.kind === "job" && l.content.slug === job.slug)
      if (existingLeaf) {
        setFocusedLeafId(existingLeaf.id)
        return
      }
      // Replace the focused leaf's content
      const content: PaneContent = { kind: "job", slug: job.slug }
      setSplitTree(prev => {
        if (!prev) return prev
        const target = focusedLeafId ?? collectLeaves(prev)[0]?.id
        if (target) {
          return replaceNode(prev, target, { type: "leaf", id: target, content })
        }
        return prev
      })
    } else {
      handleSelectJob(job)
    }
  }, [isWide, isDemo, router, splitTree, focusedLeafId, handleSelectJob])

  const handleSelectProcessWithTree = useCallback((process: ClaudeProcess) => {
    if (!isWide) {
      router.push(`/process/${process.pane_id.replace(/%/g, "_pct_")}`)
      return
    }
    if (splitTree) {
      // Check if this process is already in a pane - if so, just focus it
      const leaves = collectLeaves(splitTree)
      const existingLeaf = leaves.find(l => l.content.kind === "process" && l.content.paneId === process.pane_id)
      if (existingLeaf) {
        setFocusedLeafId(existingLeaf.id)
        return
      }
      // Replace the focused leaf's content
      const content: PaneContent = { kind: "process", paneId: process.pane_id }
      setSplitTree(prev => {
        if (!prev) return prev
        const target = focusedLeafId ?? collectLeaves(prev)[0]?.id
        if (target) {
          return replaceNode(prev, target, { type: "leaf", id: target, content })
        }
        return prev
      })
    } else {
      handleSelectProcess(process)
    }
  }, [isWide, router, splitTree, focusedLeafId, handleSelectProcess])

  const renderDraggableJobCard = useCallback(
    (props: { job: RemoteJob; status: JobStatus; onPress?: () => void; selected?: boolean | string }) => (
      <DraggableJobCard {...props} />
    ),
    [],
  )

  const renderDraggableProcessCard = useCallback(
    (props: { process: ClaudeProcess; onPress?: () => void; inGroup?: boolean; selected?: boolean | string }) => (
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
    // Also clean stale leaves from tree
    setSplitTree(prev => {
      if (!prev) return prev
      const cleaned = removeStaleLeaves(prev, (content) => {
        if (content.kind === "process") {
          return !detectedProcesses.find((p) => p.pane_id === content.paneId)
        }
        return false
      })
      return cleaned !== prev ? cleaned : prev
    })
  }, [detectedProcesses, selectedProcess, processesLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // Compute selectedItems map for sidebar highlighting
  const selectedItems = useMemo(() => {
    if (splitTree) {
      const colorMap = assignPaneColors(splitTree)
      const items = new Map<string, string>()
      for (const leaf of collectLeaves(splitTree)) {
        const key = leaf.content.kind === "job" ? leaf.content.slug : leaf.content.paneId
        items.set(key, colorMap.get(leaf.id) ?? colors.accent)
      }
      console.log("[split] selectedItems from tree:", [...items.entries()])
      return items.size > 0 ? items : null
    }
    // Single selection
    const slug = selectedJob ?? selectedProcess
    if (slug) {
      return new Map([[slug, colors.accent]])
    }
    return null
  }, [splitTree, selectedJob, selectedProcess])

  // Pane colors for the detail area
  const paneColors = useMemo(() => {
    if (!splitTree) return undefined
    return assignPaneColors(splitTree)
  }, [splitTree])

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

  // Render leaf content
  const renderLeaf = useCallback((content: PaneContent, leafId: string) => {
    if (content.kind === "job") {
      return (
        <JobDetailPane
          key={`leaf-${leafId}-${content.slug}`}
          jobName={content.slug}
          isDemo={isDemo}
          onClose={() => handleClosePane(leafId)}
        />
      )
    }
    return (
      <ProcessDetailPane
        key={`leaf-${leafId}-${content.paneId}`}
        paneId={content.paneId}
        onClose={() => handleClosePane(leafId)}
      />
    )
  }, [isDemo, handleClosePane])

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

  // Drop zone overlay - works for both tree and non-tree modes
  const effectiveTreeForOverlay = splitTree ?? (selectedJob || selectedProcess
    ? { type: "leaf" as const, id: "_root", content: selectedJob
        ? { kind: "job" as const, slug: selectedJob }
        : { kind: "process" as const, paneId: selectedProcess! } }
    : null)

  const dropOverlay = isDragging ? (
    <DropZoneOverlay
      tree={effectiveTreeForOverlay}
      containerW={detailSize.w}
      containerH={detailSize.h}
      activeZone={dragActiveZone}
    />
  ) : null

  const emptyContent = (
    <View style={styles.emptyDetail}>
      <Text style={styles.emptyDetailText}>Select a job to view details</Text>
    </View>
  )

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
            onSelectJob={splitTree ? handleSelectJobWithTree : handleSelectJob}
            onSelectProcess={splitTree ? handleSelectProcessWithTree : handleSelectProcess}
            selectedItems={selectedItems}
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
          {splitTree ? (
            <SplitDetailArea
              tree={splitTree}
              renderLeaf={renderLeaf}
              onRatioChange={handleSplitRatioChange}
              onClosePane={handleClosePane}
              onFocusLeaf={setFocusedLeafId}
              focusedLeafId={focusedLeafId}
              paneColors={paneColors}
              emptyContent={emptyContent}
              overlay={dropOverlay}
            />
          ) : (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
              {primaryContent}
              {dropOverlay}
            </div>
          )}
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
