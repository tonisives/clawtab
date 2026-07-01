import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Modal,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
} from "react-native"
import { Stack, useRouter } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { DndContext, DragOverlay } from "@dnd-kit/core"
import AsyncStorage from "@react-native-async-storage/async-storage"
import { useJobsStore } from "../../src/store/jobs"
import { useWsStore } from "../../src/store/ws"
import { useJobFilterStore } from "../../src/store/jobFilter"
import { usePinsStore } from "../../src/store/pins"
import { JobDetailPane } from "../../src/components/JobDetailPane"
import { ProcessDetailPane } from "../../src/components/ProcessDetailPane"
import { LoadingBar } from "../../src/components/LoadingBar"
import {
  JobListView,
  SplitDetailArea,
  DropZoneOverlay,
  JobCard,
  RunningJobCard,
  ProcessCard,
  useSplitTree,
} from "@clawtab/shared"
import type { PaneContent, SplitDragData } from "@clawtab/shared"
import {
  DraggableJobCard,
  DraggableProcessCard,
  type DragData,
} from "../../src/components/DraggableCards"
import { getWsSend, nextId } from "../../src/lib/wsRuntime"
import { registerRequest } from "../../src/lib/useRequestMap"
import { useResponsive } from "../../src/hooks/useResponsive"
import { DemoBanner } from "../../src/components/DemoOverlay"
import { DEMO_JOBS, DEMO_PROCESSES, DEMO_STATUSES } from "../../src/demo/data"
import { colors } from "@clawtab/shared"
import { spacing } from "@clawtab/shared"
import type { RemoteJob, JobSortMode, JobStatus, AgentModelOption } from "@clawtab/shared"
import type { DetectedProcess, ProcessProvider } from "@clawtab/shared"
import { buildModelOptions } from "../../src/lib/agentModels"

type GroupTabView = Record<string, "tabs" | "jobs">

const COLLAPSED_GROUPS_STORAGE_KEY = "remote_collapsed_groups"
const HIDDEN_GROUPS_STORAGE_KEY = "remote_hidden_groups"
const GROUP_TAB_VIEW_STORAGE_KEY = "remote_group_tab_view"
const JOB_LIST_LOADING_PROGRESS = 0.62
const SORT_OPTIONS: { value: JobSortMode; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "recent", label: "Recent" },
  { value: "added", label: "Added" },
]

function isProcessProvider(value: string | undefined): value is ProcessProvider {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "opencode" ||
    value === "antigravity" ||
    value === "shell"
  )
}

// Capture URL params before expo-router rewrites them on init
const _initParams = Platform.OS === "web" ? new URLSearchParams(window.location.search) : null

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

function persistSelection(job: string | null, process: string | null) {
  if (Platform.OS !== "web") return
  if (job) sessionStorage.setItem("sel_job", job)
  else sessionStorage.removeItem("sel_job")
  if (process) sessionStorage.setItem("sel_process", process)
  else sessionStorage.removeItem("sel_process")
}

function jobRoute(job: RemoteJob, isDemo: boolean) {
  return {
    pathname: "/job/[name]",
    params: {
      name: job.slug,
      ...(isDemo ? { demo: "1" } : {}),
    },
  } as const
}

function jobIdRoute(jobId: string) {
  return {
    pathname: "/job/[name]",
    params: { name: jobId },
  } as const
}

function processRoute(paneId: string) {
  return {
    pathname: "/process/[pane_id]",
    params: { pane_id: paneId.replace(/%/g, "_pct_") },
  } as const
}

function parseStringSet(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((group): group is string => typeof group === "string"))
  } catch {
    return new Set()
  }
}

function jobListLoadingState({
  connected,
  desktopOnline,
  loaded,
}: {
  connected: boolean
  desktopOnline: boolean
  loaded: boolean
}) {
  if (!connected) return { label: "Connecting to relay...", progress: JOB_LIST_LOADING_PROGRESS }
  if (!desktopOnline) return { label: "Connecting to desktop...", progress: JOB_LIST_LOADING_PROGRESS }
  if (!loaded) return { label: "Loading jobs...", progress: JOB_LIST_LOADING_PROGRESS }
  return null
}

function readWebStringSet(key: string): Set<string> {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return new Set()
  return parseStringSet(localStorage.getItem(key))
}

function saveStringSet(key: string, value: Set<string>) {
  const serialized = JSON.stringify([...value].sort())
  if (Platform.OS === "web" && typeof localStorage !== "undefined") {
    localStorage.setItem(key, serialized)
    return
  }
  AsyncStorage.setItem(key, serialized).catch(() => {})
}

function readGroupTabView(): GroupTabView {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return {}
  const raw = localStorage.getItem(GROUP_TAB_VIEW_STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const next: GroupTabView = {}
    for (const [group, view] of Object.entries(parsed)) {
      if (view === "tabs" || view === "jobs") next[group] = view
    }
    return next
  } catch {
    return {}
  }
}

function saveGroupTabView(value: GroupTabView) {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return
  localStorage.setItem(GROUP_TAB_VIEW_STORAGE_KEY, JSON.stringify(value))
}

export default function JobsScreen() {
  const realJobs = useJobsStore((s) => s.jobs)
  const realStatuses = useJobsStore((s) => s.statuses)
  const detectedProcesses = useJobsStore((s) => s.detectedProcesses)
  const loaded = useJobsStore((s) => s.loaded)
  const enabledModels = useJobsStore((s) => s.enabledModels)
  const connected = useWsStore((s) => s.connected)
  const desktopOnline = useWsStore((s) => s.desktopOnline)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    readWebStringSet(COLLAPSED_GROUPS_STORAGE_KEY),
  )
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(() =>
    readWebStringSet(HIDDEN_GROUPS_STORAGE_KEY),
  )
  const [sortMode, setSortMode] = useState<JobSortMode>("name")
  const [groupTabView, setGroupTabView] = useState<GroupTabView>(() => readGroupTabView())
  const [selectedJob, setSelectedJob] = useState<string | null>(() => readSelection("job"))
  const [selectedProcess, setSelectedProcess] = useState<string | null>(() =>
    readSelection("process"),
  )
  const [stoppingJobSlugs, setStoppingJobSlugs] = useState<Set<string>>(() => new Set())
  const [demoToastVisible, setDemoToastVisible] = useState(false)
  const { isWide } = useResponsive()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const searchQuery = useJobFilterStore((s) => s.query)
  const setSearchQuery = useJobFilterStore((s) => s.setQuery)
  const searchOpen = useJobFilterStore((s) => s.searchOpen)
  const closeSearch = useJobFilterStore((s) => s.closeSearch)
  const clearSearch = useJobFilterStore((s) => s.clear)
  const searchInputRef = useRef<TextInput>(null)
  const pinnedItems = usePinsStore((s) => s.pinnedItems)
  const hydratePins = usePinsStore((s) => s.hydrate)
  const togglePin = usePinsStore((s) => s.togglePin)
  const glassAvailable =
    Platform.OS === "ios" &&
    (() => {
      try {
        return isGlassEffectAPIAvailable()
      } catch {
        return false
      }
    })()

  const isDemo = connected && !desktopOnline && realJobs.length === 0
  const jobs = isDemo ? DEMO_JOBS : realJobs
  const statuses = isDemo ? DEMO_STATUSES : realStatuses
  const visibleDetectedProcesses = isDemo ? DEMO_PROCESSES : detectedProcesses

  useEffect(() => {
    setStoppingJobSlugs((prev) => {
      const next = new Set([...prev].filter((slug) => statuses[slug]?.state === "running"))
      return next.size === prev.size ? prev : next
    })
  }, [statuses])

  const DEFAULT_ENABLED = {
    claude: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
    codex: ["gpt-5.4", "gpt-5.4-mini", "o3", "o4-mini"],
    opencode: [] as string[],
    antigravity: [] as string[],
  }
  const resolvedModels =
    !enabledModels || Object.keys(enabledModels).length === 0 ? DEFAULT_ENABLED : enabledModels
  const agentModelOptions: AgentModelOption[] = buildModelOptions(
    ["claude", "codex", "opencode", "antigravity"],
    resolvedModels,
  )

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      saveStringSet(COLLAPSED_GROUPS_STORAGE_KEY, next)
      return next
    })
  }, [])

  const hideGroup = useCallback((group: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev)
      next.add(group)
      saveStringSet(HIDDEN_GROUPS_STORAGE_KEY, next)
      return next
    })
  }, [])

  const unhideGroup = useCallback((group: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev)
      next.delete(group)
      saveStringSet(HIDDEN_GROUPS_STORAGE_KEY, next)
      return next
    })
  }, [])

  useEffect(() => {
    if (Platform.OS === "web") return
    let cancelled = false
    AsyncStorage.multiGet([COLLAPSED_GROUPS_STORAGE_KEY, HIDDEN_GROUPS_STORAGE_KEY])
      .then((entries) => {
        if (cancelled) return
        const values = new Map(entries)
        setCollapsedGroups(parseStringSet(values.get(COLLAPSED_GROUPS_STORAGE_KEY) ?? null))
        setHiddenGroups(parseStringSet(values.get(HIDDEN_GROUPS_STORAGE_KEY) ?? null))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    hydratePins()
  }, [hydratePins])

  const handleRefresh = useCallback(() => {
    const send = getWsSend()
    if (send) {
      send({ type: "list_jobs", id: nextId() })
    }
  }, [])

  const handleStopJob = useCallback((slug: string) => {
    const send = getWsSend()
    if (!send) return
    const id = nextId()
    setStoppingJobSlugs((prev) => new Set(prev).add(slug))
    send({ type: "stop_job", id, name: slug })
    registerRequest<{ success: boolean; error?: string }>(id).then((ack) => {
      if (ack.success !== false) return
      setStoppingJobSlugs((prev) => {
        const next = new Set(prev)
        next.delete(slug)
        return next
      })
      console.error(`Failed to stop job ${slug}:`, ack.error)
    })
  }, [])

  const handleStopProcess = useCallback((paneId: string) => {
    const send = getWsSend()
    if (!send) return
    const process = useJobsStore.getState().detectedProcesses.find((item) => item.pane_id === paneId)
    if (process) {
      useJobsStore.getState().upsertDetectedProcess({ ...process, _transient_state: "stopping" })
    }
    const id = nextId()
    send({ type: "stop_detected_process", id, pane_id: paneId })
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
    Promise.race([
      registerRequest<{ success?: boolean; error?: string }>(id),
      timeout,
    ]).then((ack) => {
      if (ack?.success === false) {
        const current = useJobsStore.getState().detectedProcesses.find((item) => item.pane_id === paneId)
        if (current) {
          const { _transient_state: _transientState, ...rest } = current
          useJobsStore.getState().upsertDetectedProcess(rest)
        }
        console.error(`Failed to stop process ${paneId}:`, ack.error)
        return
      }
      useJobsStore.getState().removeDetectedProcess(paneId)
    })
  }, [])

  const handleGroupTabViewChange = useCallback((group: string, view: "tabs" | "jobs") => {
    setGroupTabView((prev) => {
      const next = { ...prev, [group]: view }
      saveGroupTabView(next)
      return next
    })
  }, [])

  const handleSetAllGroupTabView = useCallback((groups: string[], view: "tabs" | "jobs") => {
    setGroupTabView((prev) => {
      const next = { ...prev }
      for (const group of groups) next[group] = view
      saveGroupTabView(next)
      return next
    })
  }, [])

  const handleSelectJob = useCallback(
    (job: RemoteJob) => {
      if (isWide) {
        setSelectedJob(job.slug)
        setSelectedProcess(null)
        setSelection("job", job.slug)
      } else {
        router.push(jobRoute(job, isDemo))
      }
    },
    [router, isDemo, isWide],
  )

  const handleSelectProcess = useCallback(
    (process: DetectedProcess) => {
      if (isWide) {
        setSelectedProcess(process.pane_id)
        setSelectedJob(null)
        setSelection("process", process.pane_id)
      } else {
        router.push(processRoute(process.pane_id))
      }
    },
    [router, isWide],
  )

  // Restore URL ?params after expo-router finishes its initial URL rewrite
  useEffect(() => {
    if (Platform.OS !== "web") return
    if (!selectedJob && !selectedProcess) return
    persistSelection(selectedJob, selectedProcess)
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
    onReplaceSingle: useCallback(
      (data: SplitDragData) => {
        if (data.kind === "job") {
          const job = jobs.find((j) => j.slug === data.slug)
          if (job) handleSelectJob(job)
        } else if (data.kind === "process") {
          const proc = visibleDetectedProcesses.find((p) => p.pane_id === data.paneId)
          if (proc) handleSelectProcess(proc)
        }
      },
      [jobs, visibleDetectedProcesses, handleSelectJob, handleSelectProcess],
    ),
    currentContent,
  })
  const initialUrlSelectionPendingRef = useRef(
    Platform.OS === "web" && !!(_initParams?.get("job") || _initParams?.get("process")),
  )

  useEffect(() => {
    if (!initialUrlSelectionPendingRef.current) return
    if (!currentContent || !split.tree) return
    if (split.handleSelectInTree(currentContent)) {
      initialUrlSelectionPendingRef.current = false
    }
  }, [currentContent, split.tree, split.handleSelectInTree])

  // Wrap select handlers to check tree first
  const handleSelectJobWithTree = useCallback(
    (job: RemoteJob) => {
      if (!isWide) {
        router.push(jobRoute(job, isDemo))
        return
      }
      const content: PaneContent = { kind: "job", slug: job.slug }
      if (split.tree && split.handleSelectInTree(content)) return
      handleSelectJob(job)
    },
    [isWide, isDemo, router, split.tree, split.handleSelectInTree, handleSelectJob],
  )

  const handleSelectProcessWithTree = useCallback(
    (process: DetectedProcess) => {
      if (!isWide) {
        router.push(processRoute(process.pane_id))
        return
      }
      const content: PaneContent = { kind: "process", paneId: process.pane_id }
      if (split.tree && split.handleSelectInTree(content)) return
      handleSelectProcess(process)
    },
    [isWide, router, split.tree, split.handleSelectInTree, handleSelectProcess],
  )

  const handleRunAgent = useCallback(
    (prompt: string, workDir?: string, provider?: ProcessProvider, model?: string | null) => {
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
      registerRequest<{
        success?: boolean
        job_id?: string
        pane_id?: string
        tmux_session?: string
        work_dir?: string
        provider?: string
        error?: string
      }>(id).then((ack) => {
        if (ack.success === false) return
        if (ack.pane_id && ack.tmux_session) {
          const existing = useJobsStore.getState().detectedProcesses
          const existingProcess = existing.find((process) => process.pane_id === ack.pane_id)
          const pendingProcess: DetectedProcess = {
            ...existingProcess,
            pane_id: ack.pane_id,
            cwd: ack.work_dir ?? workDir ?? existingProcess?.cwd ?? "",
            version: existingProcess?.version ?? "",
            provider:
              provider ??
              (isProcessProvider(ack.provider)
                ? ack.provider
                : (existingProcess?.provider ?? "claude")),
            can_fork_session: existingProcess?.can_fork_session ?? false,
            can_send_skills: existingProcess?.can_send_skills ?? false,
            can_inject_secrets: existingProcess?.can_inject_secrets ?? false,
            tmux_session: ack.tmux_session,
            window_name: existingProcess?.window_name ?? "",
            matched_group: existingProcess?.matched_group ?? null,
            matched_job: ack.job_id ?? existingProcess?.matched_job ?? null,
            log_lines: existingProcess?.log_lines ?? "",
            first_query: (prompt || existingProcess?.first_query) ?? null,
            last_query: existingProcess?.last_query ?? null,
            session_started_at: existingProcess?.session_started_at ?? new Date().toISOString(),
            token_count: existingProcess?.token_count ?? null,
            _transient_state: "starting",
          }
          useJobsStore.getState().upsertDetectedProcess(pendingProcess)
          if (isWide) {
            handleSelectProcessWithTree(pendingProcess)
          } else {
            router.push(processRoute(ack.pane_id))
          }
        } else if (ack.job_id) {
          if (isWide) {
            setSelectedJob(ack.job_id)
          } else {
            router.push(jobIdRoute(ack.job_id))
          }
        }
      })
    },
    [handleSelectProcessWithTree, isWide, router],
  )

  const handleDemoRunAgent = useCallback(() => {
    setDemoToastVisible(true)
  }, [])

  useEffect(() => {
    if (!demoToastVisible) return
    const timer = setTimeout(() => setDemoToastVisible(false), 2400)
    return () => clearTimeout(timer)
  }, [demoToastVisible])

  useEffect(() => {
    if (!searchOpen || isWide) return
    const timer = setTimeout(() => searchInputRef.current?.focus(), 120)
    return () => clearTimeout(timer)
  }, [searchOpen, isWide])

  const runAgentHandler = isDemo ? handleDemoRunAgent : desktopOnline ? handleRunAgent : undefined

  const renderDraggableJobCard = useCallback(
    (props: {
      job: RemoteJob
      status: JobStatus
      onPress?: () => void
      selected?: boolean | string
      softBorder?: boolean
      onStop?: () => void
      onTogglePin?: () => void
      pinned?: boolean
      autoYesActive?: boolean
      stopping?: boolean
      defaultAgentProvider?: ProcessProvider
      groupedPosition?: "single" | "first" | "middle" | "last"
    }) => <DraggableJobCard {...props} />,
    [],
  )

  const renderDraggableProcessCard = useCallback(
    (props: {
      process: DetectedProcess
      onPress?: () => void
      inGroup?: boolean
      selected?: boolean | string
      softBorder?: boolean
      onStop?: () => void
      onTogglePin?: () => void
      pinned?: boolean
      autoYesActive?: boolean
      groupedPosition?: "single" | "first" | "middle" | "last"
    }) => <DraggableProcessCard {...props} />,
    [],
  )

  const processesLoaded = useJobsStore((s) => s.processesLoaded)

  // Clear stale selections when processes disappear
  useEffect(() => {
    if (!processesLoaded) return
    if (selectedProcess && !visibleDetectedProcesses.find((p) => p.pane_id === selectedProcess)) {
      setSelectedProcess(null)
      setSelection("process", null)
    }
    split.cleanStaleLeaves((content) => {
      if (content.kind === "process") {
        return !visibleDetectedProcesses.find((p) => p.pane_id === content.paneId)
      }
      return false
    })
  }, [visibleDetectedProcesses, selectedProcess, processesLoaded, split.cleanStaleLeaves])

  const jobListLoading = !isDemo ? jobListLoadingState({ connected, desktopOnline, loaded }) : null

  const bannerContent = (
    <>
      {jobListLoading && (
        <View style={styles.loadingContainer}>
          <LoadingBar label={jobListLoading.label} progress={jobListLoading.progress} />
        </View>
      )}
      {connected && !desktopOnline && !isDemo && realJobs.length > 0 && (
        <View style={[styles.banner, styles.bannerWarn]}>
          <Text style={styles.bannerText}>Desktop not connected</Text>
        </View>
      )}
    </>
  )

  const jobList = (
    <View style={styles.container}>
      {isDemo && <DemoBanner />}
      <JobListView
        jobs={jobs}
        statuses={statuses}
        detectedProcesses={visibleDetectedProcesses}
        collapsedGroups={collapsedGroups}
        onToggleGroup={toggleGroup}
        hiddenGroups={hiddenGroups}
        onHideGroup={hideGroup}
        onUnhideGroup={unhideGroup}
        onRefresh={handleRefresh}
        sortMode={sortMode}
        onSortChange={setSortMode}
        onSelectJob={handleSelectJob}
        onSelectProcess={handleSelectProcess}
        pinnedItems={pinnedItems}
        onTogglePin={togglePin}
        onStopJob={isDemo ? undefined : handleStopJob}
        onStopProcess={isDemo ? undefined : handleStopProcess}
        stoppingSlugs={stoppingJobSlugs}
        onRunAgent={runAgentHandler}
        agentModelOptions={agentModelOptions}
        groupTabView={groupTabView}
        onGroupTabViewChange={handleGroupTabViewChange}
        onSetAllGroupTabView={handleSetAllGroupTabView}
        headerContent={bannerContent}
        showEmpty={loaded || isDemo}
        emptyMessage={connected ? "No jobs found. Create jobs on your desktop." : "Connecting..."}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        hideSearchBar={!isWide}
      />
    </View>
  )

  const mobileJobList = (
    <JobListView
      jobs={jobs}
      statuses={statuses}
      detectedProcesses={visibleDetectedProcesses}
      collapsedGroups={collapsedGroups}
      onToggleGroup={toggleGroup}
      hiddenGroups={hiddenGroups}
      onHideGroup={hideGroup}
      onUnhideGroup={unhideGroup}
      onRefresh={handleRefresh}
      sortMode={sortMode}
      onSortChange={undefined}
      onSelectJob={handleSelectJob}
      onSelectProcess={handleSelectProcess}
      pinnedItems={pinnedItems}
      onTogglePin={togglePin}
      onStopJob={isDemo ? undefined : handleStopJob}
      onStopProcess={isDemo ? undefined : handleStopProcess}
      stoppingSlugs={stoppingJobSlugs}
      onRunAgent={runAgentHandler}
      agentModelOptions={agentModelOptions}
      groupTabView={groupTabView}
      onGroupTabViewChange={handleGroupTabViewChange}
      onSetAllGroupTabView={handleSetAllGroupTabView}
      headerContent={
        <>
          {isDemo ? <DemoBanner /> : null}
          {bannerContent}
        </>
      }
      showEmpty={loaded || isDemo}
      emptyMessage={connected ? "No jobs found. Create jobs on your desktop." : "Connecting..."}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      hideSearchBar
      contentContainerStyle={styles.mobileListContent}
      scrollEventThrottle={16}
      renderAsScrollRoot
    />
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
    return (
      <>
        <Stack.Screen
          options={{
            title: "ClawTab",
            headerLargeTitle: true,
          }}
        />
        {mobileJobList}
        <Modal visible={searchOpen} transparent animationType="fade" onRequestClose={closeSearch}>
          <KeyboardAvoidingView
            style={styles.searchKeyboardRoot}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            keyboardVerticalOffset={0}
          >
            <Pressable style={styles.searchBackdrop} onPress={closeSearch}>
              <Pressable
                style={styles.searchPanelWrap}
                onPress={(event) => event.stopPropagation()}
              >
                <GlassView
                  glassEffectStyle={glassAvailable ? "regular" : "none"}
                  isInteractive={glassAvailable}
                  colorScheme="dark"
                  style={styles.searchPanel}
                >
                  <GlassView
                    glassEffectStyle={glassAvailable ? "clear" : "none"}
                    isInteractive={glassAvailable}
                    colorScheme="dark"
                    style={styles.mobileSortRow}
                  >
                    {SORT_OPTIONS.map((option) => {
                      const active = sortMode === option.value
                      return (
                        <Pressable
                          key={option.value}
                          onPress={() => setSortMode(option.value)}
                          style={[styles.mobileSortButton, active && styles.mobileSortButtonActive]}
                        >
                          <Text
                            style={[
                              styles.mobileSortButtonText,
                              active && styles.mobileSortButtonTextActive,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      )
                    })}
                  </GlassView>
                  <GlassView
                    glassEffectStyle={glassAvailable ? "clear" : "none"}
                    isInteractive={glassAvailable}
                    colorScheme="dark"
                    style={styles.searchField}
                  >
                    <Ionicons name="search" size={18} color={colors.textMuted} />
                    <TextInput
                      ref={searchInputRef}
                      style={styles.searchInput}
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="Filter jobs..."
                      placeholderTextColor={colors.textMuted}
                      returnKeyType="done"
                      autoCapitalize="none"
                      autoCorrect={false}
                      onSubmitEditing={closeSearch}
                    />
                    {searchQuery.length > 0 ? (
                      <Pressable
                        onPress={clearSearch}
                        style={styles.searchClearButton}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                      </Pressable>
                    ) : null}
                  </GlassView>
                </GlassView>
              </Pressable>
            </Pressable>
          </KeyboardAvoidingView>
        </Modal>
        {demoToastVisible ? (
          <View style={styles.toast} pointerEvents="none">
            <Text style={styles.toastText}>
              Demo mode: cannot launch agents. Please connect desktop.
            </Text>
          </View>
        ) : null}
      </>
    )
  }

  // Render leaf content
  const renderLeaf = useCallback(
    (content: PaneContent, leafId: string) => {
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
            demoProcess={
              isDemo
                ? visibleDetectedProcesses.find((p) => p.pane_id === content.paneId)
                : undefined
            }
            onClose={() => split.handleClosePane(leafId)}
          />
        )
      }
      return null
    },
    [isDemo, split.handleClosePane, visibleDetectedProcesses],
  )

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
      demoProcess={
        isDemo ? visibleDetectedProcesses.find((p) => p.pane_id === selectedProcess) : undefined
      }
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
            return s.state === "running" ? (
              <RunningJobCard job={data.job} status={s} />
            ) : (
              <JobCard job={data.job} status={s} />
            )
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
            detectedProcesses={visibleDetectedProcesses}
            collapsedGroups={collapsedGroups}
            onToggleGroup={toggleGroup}
            hiddenGroups={hiddenGroups}
            onHideGroup={hideGroup}
            onUnhideGroup={unhideGroup}
            onRefresh={handleRefresh}
            sortMode={sortMode}
            onSortChange={setSortMode}
            onSelectJob={handleSelectJobWithTree}
            onSelectProcess={handleSelectProcessWithTree}
            pinnedItems={pinnedItems}
            onTogglePin={togglePin}
            onStopJob={isDemo ? undefined : handleStopJob}
            onStopProcess={isDemo ? undefined : handleStopProcess}
            stoppingSlugs={stoppingJobSlugs}
            selectedItems={split.selectedItems}
            focusedItemKey={split.focusedItemKey}
            onRunAgent={runAgentHandler}
            agentModelOptions={agentModelOptions}
            groupTabView={groupTabView}
            onGroupTabViewChange={handleGroupTabViewChange}
            onSetAllGroupTabView={handleSetAllGroupTabView}
            headerContent={bannerContent}
            showEmpty={loaded || isDemo}
            emptyMessage={
              connected ? "No jobs found. Create jobs on your desktop." : "Connecting..."
            }
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
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
      <DragOverlay dropAnimation={null}>{dragOverlayContent}</DragOverlay>
      {demoToastVisible ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>
            Demo mode: cannot launch agents. Please connect desktop.
          </Text>
        </View>
      ) : null}
    </DndContext>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  mobileListContent: {
    padding: 0,
    paddingTop: 0,
    paddingBottom: spacing.lg,
  },
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
  banner: {
    backgroundColor: colors.surface,
    padding: spacing.sm,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bannerWarn: { backgroundColor: "#332800" },
  bannerText: { color: colors.textSecondary, fontSize: 12 },
  searchKeyboardRoot: {
    flex: 1,
  },
  searchBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  searchPanelWrap: {
    marginHorizontal: 12,
    marginBottom: 10,
  },
  searchPanel: {
    borderRadius: 28,
    backgroundColor: "rgba(24, 24, 24, 0.72)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.18)",
    padding: 8,
    shadowColor: "#000000",
    shadowOpacity: 0.32,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
  mobileSortRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 8,
    padding: 2,
    borderRadius: 999,
    backgroundColor: "rgba(10, 10, 10, 0.58)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  mobileSortButton: {
    flex: 1,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  mobileSortButtonActive: {
    backgroundColor: "rgba(121, 134, 203, 0.72)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.18)",
  },
  mobileSortButtonText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "700",
  },
  mobileSortButtonTextActive: {
    color: colors.text,
  },
  searchField: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "rgba(10, 10, 10, 0.62)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    paddingVertical: 0,
  },
  searchClearButton: {
    padding: 2,
  },
  toast: {
    position: "absolute",
    left: 24,
    right: 24,
    bottom: 24,
    alignItems: "center",
    zIndex: 1000,
    elevation: 1000,
  },
  toastText: {
    maxWidth: 520,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 13,
    fontWeight: "600" as const,
    textAlign: "center" as const,
  },
})
