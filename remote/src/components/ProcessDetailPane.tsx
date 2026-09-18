import { MachineTerminalControls } from "@clawtab/shared";
import { useCallback, useEffect, useRef, useState, useMemo } from "react"
import { Platform, View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useJobsStore } from "../store/jobs"
import { useNotificationStore } from "../store/notifications"
import { usePinsStore } from "../store/pins"
import { useWsStore } from "../store/ws"
import { JobDetailView, StatusBadge, findYesOption, XtermLog, colors, spacing } from "@clawtab/shared"
import type { XtermLogHandle } from "@clawtab/shared"
import { getWsSend, nextId } from "../lib/wsRuntime"
import { usePty } from "../hooks/usePty"
import { registerRequest } from "../lib/useRequestMap"
import { alertError, confirm } from "../lib/platform"
import { stopSession } from "../lib/stopSession"
import type { Transport, RemoteJob, JobStatus } from "@clawtab/shared"
import { useAgentActions } from "../hooks/useAgentActions"
import { useLandscapeTerminalHeader } from "../hooks/useLandscapeTerminalHeader"
import { TerminalHeaderActions } from "./TerminalHeaderActions"
import { TerminalCopySheet } from "./TerminalCopySheet"
import { useTerminalViewportStore } from "../store/terminalViewport"

function createProcessTransport(paneId: string, onStopped?: () => void): Transport {
  const noop = async () => {}
  const noopRunJob = async () => null
  return {
    listJobs: async () => ({ jobs: [], statuses: {} }),
    getStatuses: async () => ({}),
    runJob: noopRunJob,
    stopJob: async () => {
      await stopSession(paneId)
      onStopped?.()
    },
    pauseJob: noop,
    resumeJob: noop,
    toggleJob: noop,
    deleteJob: noop,
    getRunHistory: async () => [],
    getRunDetail: async () => null,
    detectProcesses: async () => [],
    sendInput: async (_name: string, text: string, freetext?: string) => {
      const send = getWsSend()
      if (!send) return
      if (freetext) {
        const questions = useNotificationStore.getState().questions
        const q = questions.find((q) => q.pane_id === paneId)
        send({
          type: "answer_question",
          id: nextId(),
          question_id: q?.question_id ?? "",
          pane_id: paneId,
          answer: text,
          freetext,
        })
      } else {
        send({
          type: "send_detected_process_input",
          id: nextId(),
          pane_id: paneId,
          text,
        })
      }
      const questions = useNotificationStore.getState().questions
      const q = questions.find((q) => q.pane_id === paneId)
      if (q) {
        useNotificationStore.getState().answerQuestion(q.question_id)
      }
    },
    subscribeLogs: () => () => {},
    runAgent: async () => null,
    sigintJob: async () => {
      await stopSession(paneId)
      onStopped?.()
    },
  }
}

interface ProcessDetailPaneProps {
  paneId: string
  onClose: () => void
  embedded?: boolean
}

export function ProcessDetailPane({ paneId, onClose, embedded = false }: ProcessDetailPaneProps) {
  const insets = useSafeAreaInsets()
  const storeProcess = useJobsStore((s) =>
    s.detectedProcesses.find((p) => p.pane_id === paneId),
  )
  const process = storeProcess

  const connected = useWsStore((s) => s.connected)
  const desktopOnline = useWsStore((s) => s.desktopOnline)
  const loaded = useJobsStore((s) => s.loaded)
  const processesLoaded = useJobsStore((s) => s.processesLoaded)

  const lastProcessRef = useRef(process)
  if (process) lastProcessRef.current = process
  const lastProcess = lastProcessRef.current
  const activeProcess = process ?? lastProcess
  const [showPaneOverview, setShowPaneOverview] = useState(false)
  let agentActionControls = useAgentActions(paneId, showPaneOverview)

  const displayName = activeProcess
    ? activeProcess.cwd.replace(/^\/Users\/[^/]+/, "~")
    : paneId

  const pinnedItems = usePinsStore((s) => s.pinnedItems)
  const hydratePins = usePinsStore((s) => s.hydrate)
  const togglePin = usePinsStore((s) => s.togglePin)
  const pinKey = `pane:${paneId}`
  const isPinned = pinnedItems.includes(pinKey)
  const handleTogglePin = useCallback(() => {
    togglePin(pinKey)
  }, [pinKey, togglePin])

  const [logs, setLogs] = useState(process?.log_lines ?? "")
  const [logsLoaded, setLogsLoaded] = useState(!!process)

  // Poll logs
  useEffect(() => {
    if (!activeProcess) return
    if (process) {
      setLogs(process.log_lines ?? "")
      setLogsLoaded(true)
      return
    }
    let active = true
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const send = getWsSend()
        if (!send) return
        const id = nextId()
        send({
          type: "get_detected_process_logs",
          id,
          tmux_session: activeProcess.tmux_session,
          pane_id: activeProcess.pane_id,
        })
        const timeout = new Promise<{ logs?: string }>((resolve) =>
          setTimeout(() => resolve({}), 5000),
        )
        const resp = await Promise.race([registerRequest<{ logs?: string }>(id), timeout])
        if (active && resp.logs != null) {
          setLogs(resp.logs.trimEnd())
          setLogsLoaded(true)
        }
      } finally {
        polling = false
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [activeProcess?.pane_id, activeProcess?.tmux_session, process])

  const questions = useNotificationStore((s) => s.questions)
  const paneQuestion = questions.find((q) => q.pane_id === paneId)
  useEffect(() => {
    hydratePins()
  }, [hydratePins])

  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds)
  const enableAutoYes = useNotificationStore((s) => s.enableAutoYes)
  const disableAutoYes = useNotificationStore((s) => s.disableAutoYes)
  const answerQuestion = useNotificationStore((s) => s.answerQuestion)
  const autoYesActive = autoYesPaneIds.has(paneId)

  const handleToggleAutoYes = useCallback(() => {
    if (autoYesPaneIds.has(paneId)) {
      disableAutoYes(paneId)
      const send = getWsSend()
      if (send) {
        const next = new Set(autoYesPaneIds)
        next.delete(paneId)
        send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] })
      }
      return
    }
    confirm("Enable auto-yes?", `All future questions for "${displayName}" will be automatically accepted with "Yes". This stays active until you disable it.`, () => {
      enableAutoYes(paneId)
      const send = getWsSend()
      if (send) {
        const next = new Set(autoYesPaneIds)
        next.add(paneId)
        send({ type: "set_auto_yes_panes", id: nextId(), pane_ids: [...next] })
      }
      if (paneQuestion) {
        const yesOpt = findYesOption(paneQuestion)
        if (yesOpt) {
          const s = getWsSend()
          if (s) {
            s({ type: "send_detected_process_input", id: nextId(), pane_id: paneId, text: yesOpt })
          }
          setTimeout(() => answerQuestion(paneQuestion.question_id), 1500)
        }
      }
    })
  }, [paneId, autoYesPaneIds, enableAutoYes, disableAutoYes, displayName, paneQuestion, answerQuestion])

  const handleTitlePress = useCallback(() => {
    setShowPaneOverview(true)
  }, [])

  const handleStopped = useCallback(() => {
    useJobsStore.getState().removeDetectedProcess(paneId)
    onClose()
  }, [paneId, onClose])

  const transport = useMemo(() => createProcessTransport(paneId, handleStopped), [paneId, handleStopped])

  const [stopping, setStopping] = useState(false)
  const handleStop = useCallback(() => {
    if (stopping) return
    confirm("Stop session", `Close the terminal session in ${displayName} and stop any program running in it?`, async () => {
      setStopping(true)
      try {
        await transport.stopJob(paneId)
      } catch (error) {
        alertError("Could not stop session", error instanceof Error ? error.message : "Please try again.")
      } finally {
        setStopping(false)
      }
    })
  }, [displayName, paneId, stopping, transport])

  // PTY streaming terminal
  const termRef = useRef<XtermLogHandle | null>(null)
  const tmuxSession = activeProcess?.tmux_session ?? ""
  const { sendInput, sendResize, connecting: ptyConnecting, error: ptyError } = usePty(paneId, tmuxSession, termRef)
  const landscapeHeader = useLandscapeTerminalHeader(!!activeProcess)
  const fitSafeArea = useTerminalViewportStore((s) => s.fitSafeArea)
  const setFitSafeArea = useTerminalViewportStore((s) => s.setFitSafeArea)
  const [copyText, setCopyText] = useState<string | null>(null)

  const renderTerminal = useCallback(
    () => (
      <View style={{ flex: 1, minHeight: 0 }}>
        {ptyConnecting || ptyError ? (
          <View style={styles.ptyConnecting}>
            {ptyConnecting ? <ActivityIndicator size="small" color={colors.accent} /> : null}
            <Text style={styles.ptyConnectingText}>
              {ptyError ?? "Connecting to terminal..."}
            </Text>
          </View>
        ) : null}
        {Platform.OS !== "ios" && <MachineTerminalControls paneId={paneId} />}
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

  // Keep the terminal and its stop action available through login, startup, and shell prompts.
  const isAlive = !!activeProcess
  const waitingForData = !process && !questions.some((q) => q.pane_id === paneId) && (!connected || !desktopOnline || !processesLoaded)

  if (waitingForData) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.loadingText}>
          {!connected ? "Connecting..." : "Loading..."}
        </Text>
      </View>
    )
  }

  if (!activeProcess) {
    return (
      <View style={styles.center}>
        <Text style={styles.notFound}>Process not found</Text>
      </View>
    )
  }

  const syntheticJob: RemoteJob = {
    name: displayName,
    job_type: activeProcess.provider,
    agent_provider: activeProcess.provider,
    enabled: true,
    cron: "",
    group: "detected",
    slug: paneId,
    work_dir: activeProcess.cwd,
  }

  const syntheticStatus: JobStatus = isAlive
    ? { state: "running", run_id: "", started_at: new Date().toISOString(), pane_id: paneId }
    : { state: "idle" }
  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: embedded ? spacing.md : insets.top + spacing.md }]}>
        <TouchableOpacity
          style={styles.titleButton}
          onPress={handleTitlePress}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Open pane overview"
        >
          <Text style={styles.title} numberOfLines={1}>{displayName}</Text>
        </TouchableOpacity>
        {landscapeHeader.isLandscape ? (
          <TerminalHeaderActions fitSafeArea={fitSafeArea} onChangeViewport={setFitSafeArea} onOpenDetails={handleTitlePress} />
        ) : <StatusBadge status={syntheticStatus} />}
      </View>
      <JobDetailView
        transport={transport}
        job={syntheticJob}
        status={syntheticStatus}
        logs={logsLoaded ? logs : "Loading..."}
        runs={[]}
        runsLoading={false}
        onBack={onClose}
        showBackButton={false}
        hideRuns
        hidePath
        expandOutput
        hideInfoPanels={landscapeHeader.isLandscape}
        options={paneQuestion?.options}
        questionContext={paneQuestion?.context_lines}
        renderTerminal={isAlive ? renderTerminal : undefined}
        hideMessageInput={isAlive}
        paneOverview={{
          paneId,
          startedAt: activeProcess?.session_started_at,
          cwd: activeProcess?.cwd,
          tmuxSession: activeProcess?.tmux_session,
          windowName: activeProcess?.window_name || paneQuestion?.window_name,
          firstQuery: activeProcess?.first_query,
          lastQuery: activeProcess?.last_query,
        }}
        paneOverviewActions={{
          autoYesActive,
          onToggleAutoYes: handleToggleAutoYes,
          isPinned,
          onTogglePin: handleTogglePin,
          onStop: handleStop,
          stopping,
          ...agentActionControls,
        }}
        paneOverviewVisible={showPaneOverview}
        onPaneOverviewVisibleChange={setShowPaneOverview}
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
  titleButton: {
    flex: 1,
    minWidth: 0,
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
