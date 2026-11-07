import { useModelCatalog } from "@clawtab/shared";
import { ShellSurface } from "./ShellSurface";
import { toggleAutoYes } from "../lib/autoYes"
import { useCallback, useEffect, useState } from "react"
import { Platform, View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Keyboard } from "react-native"
import { useRouter } from "expo-router"
import { useLandscapeShellStore } from "../store/landscapeShell"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useJobsStore, useJob, useJobStatus } from "../store/jobs"
import { useRunsStore } from "../store/runs"
import { useNotificationStore } from "../store/notifications"
import { useWsStore } from "../store/ws"
import { JobDetailView, compactPath, findYesOption, StatusBadge } from "@clawtab/shared"
import { useLogs } from "../hooks/useLogs"
import { createWsTransport } from "../transport/wsTransport"
import { getWsSend, nextId } from "../lib/wsRuntime"
import { registerRequest } from "../lib/useRequestMap"
import { colors, spacing } from "@clawtab/shared"
import type { AgentModelOption, JobUpdate, ProcessProvider, RemoteJob, RunRecord } from "@clawtab/shared"
import { buildModelOptions } from "../lib/agentModels"
import { useLandscapeTerminalHeader } from "../hooks/useLandscapeTerminalHeader"
import { TerminalHeaderActions } from "./TerminalHeaderActions"
import { useAgentActions } from "../hooks/useAgentActions"

const wsTransport = createWsTransport()
const AGENT_PROVIDERS: ProcessProvider[] = ["claude", "codex", "opencode", "antigravity", "hermes"]


function agentJobFromSlug(slug: string): RemoteJob {
  const folder = slug.replace(/^agent-/, "")
  return {
    name: slug,
    job_type: "claude",
    enabled: true,
    cron: "",
    group: "agent",
    slug,
    work_dir: folder,
  }
}

interface JobDetailPaneProps {
  jobName: string
  onClose: () => void
  embedded?: boolean
}

export function JobDetailPane({ jobName, onClose, embedded = false }: JobDetailPaneProps) {
  useModelCatalog();
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const storeJob = useJob(jobName)
  const defaultAgentProvider = useJobsStore((s) => s.defaultProvider)
  const defaultAgentModel = useJobsStore((s) => s.defaultModel)
  const enabledModels = useJobsStore((s) => s.enabledModels)
  const isAgent = !storeJob && jobName.startsWith("agent-")
  const job = storeJob ?? (isAgent ? agentJobFromSlug(jobName) : undefined)
  const slug = job?.slug ?? jobName
  const modelOptions: AgentModelOption[] = buildModelOptions(AGENT_PROVIDERS, enabledModels ?? {})
  const onUpdateJob = useCallback(async (patch: JobUpdate) => {
    if (wsTransport.updateJob) await wsTransport.updateJob(slug, patch)
  }, [slug])
  const realStatus = useJobStatus(jobName)
  const status = realStatus
  const statusPaneId = status?.state === "running" ? (status as any).pane_id ?? "" : ""
  let activeProcess = useJobsStore((state) => state.detectedProcesses.find((process) => process.pane_id === statusPaneId))
  const { logs } = useLogs(slug)
  const runs = useRunsStore((s) => s.runs[slug]) ?? null
  const [runsLoading, setRunsLoading] = useState(false)
  const connected = useWsStore((s) => s.connected)

  const questions = useNotificationStore((s) => s.questions)
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds)
  const answerQuestion = useNotificationStore((s) => s.answerQuestion)
  const jobQuestion = questions.find((q) => q.matched_job === slug)
  const autoYesPaneId = jobQuestion?.pane_id ?? statusPaneId
  const autoYesActive = !!autoYesPaneId && autoYesPaneIds.has(autoYesPaneId)
  const canToggleAutoYes = !!autoYesPaneId

  const loadRuns = useCallback(() => {
    const send = getWsSend()
    if (!send || !jobName) return
    const id = nextId()
    setRunsLoading(true)
    send({ type: "get_run_history", id, name: slug, limit: 50 })
    registerRequest<RunRecord[]>(id).then((result) => {
      useRunsStore.getState().setRuns(slug, result)
      setRunsLoading(false)
    })
  }, [slug, jobName])

  useEffect(() => {
    loadRuns()
  }, [loadRuns])

  useEffect(() => {
    if (connected) {
      loadRuns()
    }
  }, [connected]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleAutoYes = useCallback(() => {
    if (!autoYesPaneId) return
    toggleAutoYes(autoYesPaneId, jobQuestion?.matched_job ?? jobQuestion?.cwd.replace(/^\/Users\/[^/]+/, "~") ?? slug, () => {
      let yesOpt = jobQuestion ? findYesOption(jobQuestion) : undefined
      let send = getWsSend()
      if (!yesOpt || !send) return
      send({ type: "send_input", id: nextId(), name: slug, text: yesOpt })
      if (jobQuestion) setTimeout(() => answerQuestion(jobQuestion.question_id), 1500)
    })
  }, [autoYesPaneId, jobQuestion, answerQuestion, slug])

  const loaded = useJobsStore((s) => s.loaded)

  const statusTmuxSession = status?.state === "running" ? (status as any).tmux_session ?? "" : ""
  const isRunningWithShell = !!statusPaneId
  const landscapeHeader = useLandscapeTerminalHeader(isRunningWithShell)
  const [showPaneOverview, setShowPaneOverview] = useState(false)
  let agentActionControls = useAgentActions(statusPaneId, showPaneOverview)
  const zoomToFullScreen = useCallback(() => {
    Keyboard.dismiss()
    useLandscapeShellStore.getState().showFullScreen({ kind: "job", slug })
    router.push({ pathname: "/job/[name]", params: { name: slug, fromSplit: "1" } })
  }, [router, slug])

  const renderTerminal = useCallback(() => <ShellSurface paneId={statusPaneId} onScrollGesture={landscapeHeader.onScrollGesture} />, [statusPaneId, landscapeHeader.onScrollGesture])

  if (!job) {
    const waiting = !loaded || !connected
    return (
      <View style={styles.center}>
        {waiting ? (
          <>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.loadingText}>
              {!connected ? "Connecting..." : "Loading..."}
            </Text>
          </>
        ) : (
          <Text style={styles.notFound}>Job not found</Text>
        )}
      </View>
    )
  }

  return (
    <View style={styles.container}>
      {Platform.OS !== "web" && (landscapeHeader.headerShown || landscapeHeader.overlayShown) ? <View style={[styles.header, landscapeHeader.isLandscape && styles.landscapeHeaderOverlay, { paddingTop: embedded ? spacing.md : insets.top + spacing.md }]}>
        <Text style={styles.title} numberOfLines={1}>{landscapeHeader.isLandscape ? compactPath(job.work_dir) : job.name}</Text>
        {landscapeHeader.isLandscape && isRunningWithShell ? (
          <TerminalHeaderActions onZoom={zoomToFullScreen} onOpenDetails={() => setShowPaneOverview(true)} />
        ) : <TouchableOpacity
          onPress={canToggleAutoYes ? handleToggleAutoYes : undefined}
          disabled={!canToggleAutoYes}
          activeOpacity={0.6}
          accessibilityRole={canToggleAutoYes ? "button" : undefined}
          accessibilityLabel={canToggleAutoYes ? (autoYesActive ? "Disable auto-yes" : "Enable auto-yes") : "Status"}
        >
          <StatusBadge status={status} colorOverride={autoYesActive ? colors.warning : undefined} />
        </TouchableOpacity>}
      </View> : null}
      <JobDetailView
        transport={wsTransport}
        job={job}
        status={status}
        logs={logs}
        runs={runs}
        runsLoading={runsLoading}
        onBack={onClose}
        showBackButton={false}
        hidePath
        mobileDetails={Platform.OS === "web"}
        hideInfoPanels={landscapeHeader.isLandscape && isRunningWithShell}
        paneOverview={statusPaneId ? { paneId: statusPaneId, tmuxSession: statusTmuxSession, cwd: activeProcess?.cwd ?? job.work_dir, windowName: activeProcess?.window_name, startedAt: activeProcess?.session_started_at, firstQuery: activeProcess?.first_query, lastQuery: activeProcess?.last_query } : undefined}
        paneOverviewActions={{ autoYesActive, onToggleAutoYes: canToggleAutoYes ? handleToggleAutoYes : undefined, ...agentActionControls }}
        paneOverviewVisible={showPaneOverview}
        onPaneOverviewVisibleChange={setShowPaneOverview}
        onReloadRuns={loadRuns}
        options={jobQuestion?.options}
        autoYesActive={autoYesActive}
        onToggleAutoYes={!autoYesPaneId ? undefined : handleToggleAutoYes}
        renderTerminal={isRunningWithShell ? renderTerminal : undefined}
        hideMessageInput={isRunningWithShell}
        expandOutput={isRunningWithShell}
        defaultOutputCollapsed
        defaultRunsCollapsed
        defaultAgentProvider={(defaultAgentProvider ?? undefined) as import("@clawtab/shared").ProcessProvider | undefined}
        defaultAgentModel={defaultAgentModel}
        agentModelOptions={modelOptions}
        onUpdateJob={!isAgent ? onUpdateJob : undefined}
        optionBarBottomInset={insets.bottom}
        terminalOptionsOverlay={false}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  landscapeHeaderOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
    flex: 1,
    marginRight: spacing.sm,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  notFound: {
    color: colors.textMuted,
    fontSize: 16,
  },
  loadingText: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 8,
  },
})
