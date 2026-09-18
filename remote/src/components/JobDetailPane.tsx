import { MachineTerminalControls } from "@clawtab/shared";
import { useCallback, useEffect, useRef, useState } from "react"
import { Platform, View, Text, StyleSheet, ActivityIndicator, Alert, TouchableOpacity } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useJobsStore, useJob, useJobStatus } from "../store/jobs"
import { useRunsStore } from "../store/runs"
import { useNotificationStore } from "../store/notifications"
import { useWsStore } from "../store/ws"
import { JobDetailView, compactPath, findYesOption, StatusBadge, XtermLog } from "@clawtab/shared"
import type { XtermLogHandle } from "@clawtab/shared"
import { useLogs } from "../hooks/useLogs"
import { usePty } from "../hooks/usePty"
import { createWsTransport } from "../transport/wsTransport"
import { getWsSend, nextId } from "../lib/wsRuntime"
import { registerRequest } from "../lib/useRequestMap"
import { colors, spacing } from "@clawtab/shared"
import type { AgentModelOption, JobUpdate, ProcessProvider, RemoteJob, RunRecord } from "@clawtab/shared"
import { buildModelOptions } from "../lib/agentModels"
import { useLandscapeTerminalHeader } from "../hooks/useLandscapeTerminalHeader"
import { TerminalHeaderActions } from "./TerminalHeaderActions"
import { TerminalCopySheet } from "./TerminalCopySheet"
import { useTerminalViewportStore } from "../store/terminalViewport"

const wsTransport = createWsTransport()
const AGENT_PROVIDERS: ProcessProvider[] = ["claude", "codex", "opencode", "antigravity"]


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
  const { logs } = useLogs(slug)
  const runs = useRunsStore((s) => s.runs[slug]) ?? null
  const [runsLoading, setRunsLoading] = useState(false)
  const connected = useWsStore((s) => s.connected)

  const questions = useNotificationStore((s) => s.questions)
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds)
  const enableAutoYes = useNotificationStore((s) => s.enableAutoYes)
  const disableAutoYes = useNotificationStore((s) => s.disableAutoYes)
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
    if (autoYesPaneIds.has(autoYesPaneId)) {
      disableAutoYes(autoYesPaneId)
      const send = getWsSend()
      if (send) {
        const next = new Set(autoYesPaneIds)
        next.delete(autoYesPaneId)
        send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] })
      }
      return
    }
    const title = jobQuestion?.matched_job ?? jobQuestion?.cwd.replace(/^\/Users\/[^/]+/, "~") ?? slug
    Alert.alert(
      "Enable auto-yes?",
      `All future questions for "${title}" will be automatically accepted with "Yes". This stays active until you disable it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Enable",
          style: "destructive",
          onPress: () => {
            enableAutoYes(autoYesPaneId)
            const send = getWsSend()
            if (send) {
              const next = new Set(autoYesPaneIds)
              next.add(autoYesPaneId)
              send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] })
            }
            const yesOpt = jobQuestion ? findYesOption(jobQuestion) : undefined
            if (yesOpt) {
              const s = getWsSend()
              if (s) s({ type: "send_input", id: nextId(), name: slug, text: yesOpt })
              if (jobQuestion) setTimeout(() => answerQuestion(jobQuestion.question_id), 1500)
            }
          },
        },
      ],
    )
  }, [autoYesPaneId, jobQuestion, autoYesPaneIds, enableAutoYes, disableAutoYes, answerQuestion, slug])

  const loaded = useJobsStore((s) => s.loaded)

  // PTY streaming for running jobs
  const statusTmuxSession = status?.state === "running" ? (status as any).tmux_session ?? "" : ""
  const termRef = useRef<XtermLogHandle | null>(null)
  const { sendInput, sendResize, connecting: ptyConnecting, error: ptyError } = usePty(statusPaneId, statusTmuxSession, termRef)
  const isRunningWithPty = !!statusPaneId && !!statusTmuxSession
  const landscapeHeader = useLandscapeTerminalHeader(isRunningWithPty)
  const fitSafeArea = useTerminalViewportStore((s) => s.fitSafeArea)
  const setFitSafeArea = useTerminalViewportStore((s) => s.setFitSafeArea)
  const [copyText, setCopyText] = useState<string | null>(null)
  const [showPaneOverview, setShowPaneOverview] = useState(false)

  const renderTerminal = useCallback(
    () => (
      <View style={{ flex: 1, minHeight: 0 }}>
        <View style={[styles.ptyConnecting, !ptyConnecting && !ptyError && styles.ptyConnectingHidden]}>
          {ptyConnecting || ptyError ? (
            <>
              {ptyConnecting ? <ActivityIndicator size="small" color={colors.accent} /> : null}
              <Text style={styles.ptyConnectingText}>
                {ptyError ?? "Connecting to terminal..."}
              </Text>
            </>
          ) : null}
        </View>
        {Platform.OS !== "ios" && <MachineTerminalControls paneId={statusPaneId ?? ""} />}
        <XtermLog
          ref={termRef}
          onData={sendInput}
          onResize={sendResize}
          interactive
          forceDarkTheme
          extendedViewport={Platform.OS === "ios"}
          extendedViewportHeight={350}
          onLongPressCopyText={setCopyText}
        />
      </View>
    ),
    [sendInput, sendResize, ptyConnecting, ptyError],
  )

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
      <View style={[styles.header, { paddingTop: embedded ? spacing.md : insets.top + spacing.md }]}>
        <Text style={styles.title} numberOfLines={1}>{landscapeHeader.isLandscape ? compactPath(job.work_dir) : job.name}</Text>
        {landscapeHeader.isLandscape && isRunningWithPty ? (
          <TerminalHeaderActions fitSafeArea={fitSafeArea} onChangeViewport={setFitSafeArea} onOpenDetails={() => setShowPaneOverview(true)} />
        ) : <TouchableOpacity
          onPress={canToggleAutoYes ? handleToggleAutoYes : undefined}
          disabled={!canToggleAutoYes}
          activeOpacity={0.6}
          accessibilityRole={canToggleAutoYes ? "button" : undefined}
          accessibilityLabel={canToggleAutoYes ? (autoYesActive ? "Disable auto-yes" : "Enable auto-yes") : "Status"}
        >
          <StatusBadge status={status} colorOverride={autoYesActive ? colors.warning : undefined} />
        </TouchableOpacity>}
      </View>
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
        hideInfoPanels={landscapeHeader.isLandscape && isRunningWithPty}
        paneOverview={statusPaneId ? { paneId: statusPaneId, tmuxSession: statusTmuxSession, cwd: job.work_dir } : undefined}
        paneOverviewActions={{ autoYesActive, onToggleAutoYes: handleToggleAutoYes }}
        paneOverviewVisible={showPaneOverview}
        onPaneOverviewVisibleChange={setShowPaneOverview}
        onReloadRuns={loadRuns}
        options={jobQuestion?.options}
        questionContext={jobQuestion?.context_lines}
        autoYesActive={autoYesActive}
        onToggleAutoYes={!autoYesPaneId ? undefined : handleToggleAutoYes}
        renderTerminal={isRunningWithPty ? renderTerminal : undefined}
        hideMessageInput={isRunningWithPty}
        expandOutput={isRunningWithPty}
        defaultOutputCollapsed
        defaultRunsCollapsed
        defaultAgentProvider={(defaultAgentProvider ?? undefined) as import("@clawtab/shared").ProcessProvider | undefined}
        defaultAgentModel={defaultAgentModel}
        agentModelOptions={modelOptions}
        onUpdateJob={!isAgent ? onUpdateJob : undefined}
      />
      <TerminalCopySheet text={copyText} onClose={() => setCopyText(null)} />
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
  ptyConnecting: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 8,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ptyConnectingHidden: {
    height: 0,
    paddingVertical: 0,
    borderBottomWidth: 0,
    overflow: "hidden",
  },
  ptyConnectingText: {
    color: colors.textMuted,
    fontSize: 12,
  },
})
