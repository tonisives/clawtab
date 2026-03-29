import { useCallback, useEffect, useRef, useState, useMemo } from "react"
import { View, Text, StyleSheet, ActivityIndicator } from "react-native"
import { useJobsStore } from "../store/jobs"
import { useNotificationStore } from "../store/notifications"
import { useWsStore } from "../store/ws"
import { JobDetailView, StatusBadge, findYesOption, colors, spacing } from "@clawtab/shared"
import { getWsSend, nextId } from "../hooks/useWebSocket"
import { registerRequest } from "../lib/useRequestMap"
import { confirm } from "../lib/platform"
import type { Transport, RemoteJob, JobStatus } from "@clawtab/shared"

function createProcessTransport(paneId: string): Transport {
  const noop = async () => {}
  return {
    listJobs: async () => ({ jobs: [], statuses: {} }),
    getStatuses: async () => ({}),
    runJob: noop,
    stopJob: async () => {
      const send = getWsSend()
      if (!send) return
      const id = nextId()
      send({ type: "stop_detected_process", id, pane_id: paneId })
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000))
      await Promise.race([registerRequest(id), timeout])
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
    runAgent: noop,
    sigintJob: async () => {
      const send = getWsSend()
      if (!send) return
      const id = nextId()
      send({ type: "stop_detected_process", id, pane_id: paneId })
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000))
      await Promise.race([registerRequest(id), timeout])
    },
  }
}

interface ProcessDetailPaneProps {
  paneId: string
  onClose: () => void
}

export function ProcessDetailPane({ paneId, onClose }: ProcessDetailPaneProps) {
  const process = useJobsStore((s) =>
    s.detectedProcesses.find((p) => p.pane_id === paneId),
  )

  const connected = useWsStore((s) => s.connected)
  const desktopOnline = useWsStore((s) => s.desktopOnline)
  const loaded = useJobsStore((s) => s.loaded)

  const lastProcessRef = useRef(process)
  if (process) lastProcessRef.current = process
  const lastProcess = lastProcessRef.current
  const activeProcess = process ?? lastProcess

  const displayName = activeProcess
    ? activeProcess.cwd.replace(/^\/Users\/[^/]+/, "~")
    : paneId

  const [logs, setLogs] = useState(process?.log_lines ?? "")
  const [logsLoaded, setLogsLoaded] = useState(!!process?.log_lines)

  // Poll logs
  useEffect(() => {
    if (!activeProcess) return
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
  }, [activeProcess?.pane_id, activeProcess?.tmux_session])

  const questions = useNotificationStore((s) => s.questions)
  const paneQuestion = questions.find((q) => q.pane_id === paneId)
  const autoYesPaneIds = useNotificationStore((s) => s.autoYesPaneIds)
  const enableAutoYes = useNotificationStore((s) => s.enableAutoYes)
  const disableAutoYes = useNotificationStore((s) => s.disableAutoYes)
  const answerQuestion = useNotificationStore((s) => s.answerQuestion)
  const autoYesActive = paneQuestion ? autoYesPaneIds.has(paneId) : false

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

  const transport = useMemo(() => createProcessTransport(paneId), [paneId])

  const isAlive = !!process
  const waitingForData = !process && !questions.some((q) => q.pane_id === paneId) && (!connected || !desktopOnline || !loaded)

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
    job_type: "claude",
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
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>{displayName}</Text>
        <StatusBadge status={syntheticStatus} />
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
        expandOutput
        options={paneQuestion?.options}
        questionContext={paneQuestion?.context_lines}
        autoYesActive={autoYesActive}
        onToggleAutoYes={paneQuestion ? handleToggleAutoYes : undefined}
        firstQuery={activeProcess?.first_query ?? undefined}
        lastQuery={activeProcess?.last_query ?? undefined}
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
